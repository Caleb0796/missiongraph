import type { Event } from "./events.js";
import type { Approval, GraphState } from "./reducer.js";
import { remainingPathFrom } from "./reducer.js";

export interface DigestChange {
  seq: number;
  actor: string;
  type: string;
  one_liner: string;
}

export interface Digest {
  summary: {
    counts_by_state: Record<"ready" | "blocked" | "running" | "review" | "done" | "failed" | "paused", number>;
    critical_path_node_ids: string[];
    pending_approvals: {
      approval_id: string;
      node_id: string;
      node_title: string;
      summary: string;
      delay_impact_min: number;
      age_since: string;
    }[];
    ready_unassigned: {
      node_id: string;
      node_title: string;
      idle_since: string;
      on_critical_path: boolean;
    }[];
  };
  changes_since: DigestChange[];
  cursor: string;
}

function actorName(actor: string): string {
  if (actor === "human") return "Human";
  if (actor === "browser_agent") return "Browser agent";
  if (actor === "supervisor") return "Supervisor";
  return `Worker ${actor.slice("worker:".length)}`;
}

function nodeName(state: GraphState, id: string): string {
  const title = state.nodes[id]?.title ?? state.tombstones[id]?.node.title;
  return title ? `“${title}” (${id})` : id;
}

function edgeName(state: GraphState, id: string): string {
  const edge = state.edges[id];
  return edge ? `${nodeName(state, edge.upstream)} → ${nodeName(state, edge.downstream)}` : id;
}

export function oneLiner(event: Event, state: GraphState): string {
  const actor = actorName(event.actor);
  switch (event.type) {
    case "TASK_ADDED":
      return `${actor} added task ${nodeName(state, event.payload.node.id)}.`;
    case "TASK_REMOVED":
      return `${actor} removed task ${nodeName(state, event.payload.node_id)} and tombstoned its history.`;
    case "TASK_SPLIT":
      return `${actor} split ${nodeName(state, event.payload.parent_id)} into ${event.payload.children.map((child) => nodeName(state, child.id)).join(", ")}.`;
    case "EDGE_ADDED":
      return event.payload.kind === "depends"
        ? `${actor} made ${nodeName(state, event.payload.downstream)} depend on ${nodeName(state, event.payload.upstream)}.`
        : `${actor} marked a work conflict between ${nodeName(state, event.payload.upstream)} and ${nodeName(state, event.payload.downstream)}.`;
    case "EDGE_REMOVED":
      return `${actor} removed graph edge ${event.payload.edge_id}.`;
    case "DISPATCHED":
      return `${actor} dispatched ${nodeName(state, event.payload.node_id)} to the supervisor.`;
    case "RETRY_REQUESTED":
      return `${actor} requested another attempt on ${nodeName(state, event.payload.node_id)} with new guidance.`;
    case "PAUSE_REQUESTED":
      return `${actor} asked the worker on ${nodeName(state, event.payload.node_id)} to pause safely.`;
    case "RESUME_REQUESTED":
      return `${actor} asked the worker on ${nodeName(state, event.payload.node_id)} to resume.`;
    case "APPROVED":
      return `${actor} approved ${nodeName(state, event.payload.node_id)}, completing the task.`;
    case "REJECTED":
      return `${actor} rejected ${nodeName(state, event.payload.node_id)}, returning it for revision.`;
    case "POLICY_STATED":
      return `${actor} stated an approval policy for this browser session: ${event.payload.text}`;
    case "ANNOTATED":
      return `${actor} annotated ${state.nodes[event.payload.target_id] ? nodeName(state, event.payload.target_id) : edgeName(state, event.payload.target_id)}: ${event.payload.note}`;
    case "JOURNAL_NOTE":
      return `${actor} added a project journal note: ${event.payload.text}`;
    case "NODE_STATE_CHANGED":
      return `${actor} moved ${nodeName(state, event.payload.node_id)} from ${event.payload.from} to ${event.payload.to}.`;
    case "PAUSE_ACKED":
      return `${actor} confirmed that ${nodeName(state, event.payload.node_id)} paused safely.`;
    case "WORKER_LOG":
      return `${actor} reported ${event.payload.lines.length} new log ${event.payload.lines.length === 1 ? "line" : "lines"} for ${nodeName(state, event.payload.node_id)}.`;
    case "HANDOFF_FILED":
      return `${actor} filed the handoff for ${nodeName(state, event.payload.node_id)}: ${event.payload.handoff.summary}`;
    case "DEVIATION_NOTED":
      return `${actor} noted a ${event.payload.kind} deviation on ${nodeName(state, event.payload.node_id)}: ${event.payload.text}`;
    case "APPROVAL_CREATED":
      return `${actor} submitted ${nodeName(state, event.payload.node_id)} for approval: ${event.payload.summary}`;
    case "NODE_MOVED":
      return `${actor} moved ${nodeName(state, event.payload.node_id)} on the canvas.`;
    case "SELECTION_CHANGED":
      return `${actor} selected ${event.payload.selected.length === 0 ? "nothing" : event.payload.selected.map((id) => nodeName(state, id)).join(", ")}.`;
  }
}

function approvalRank(state: GraphState, approval: Approval): number {
  return remainingPathFrom(state, approval.node_id).weight;
}

export function buildDigest(state: GraphState, events: readonly Event[], since = 0): Digest {
  const counts = {
    ready: 0,
    blocked: 0,
    running: 0,
    review: 0,
    done: 0,
    failed: 0,
    paused: 0,
  };
  for (const current of Object.values(state.nodes)) {
    if (current.record_type === "group") continue;
    if (current.state === "queued") {
      counts[current.availability ?? "blocked"] += 1;
    } else {
      counts[current.state] += 1;
    }
  }
  const pending = Object.values(state.approvals)
    .filter((approval) => approval.status === "pending")
    .sort((left, right) => {
      const impact = approvalRank(state, right) - approvalRank(state, left);
      if (impact !== 0) return impact;
      const age = left.created_at.localeCompare(right.created_at);
      return age !== 0 ? age : left.id.localeCompare(right.id);
    })
    .map((approval) => ({
      approval_id: approval.id,
      node_id: approval.node_id,
      node_title: state.nodes[approval.node_id]?.title ?? approval.node_id,
      summary: approval.summary,
      delay_impact_min: approvalRank(state, approval),
      age_since: approval.created_at,
    }));
  const ready = Object.values(state.nodes)
    .filter(
      (current) =>
        current.record_type === "task" &&
        current.state === "queued" &&
        current.availability === "ready" &&
        !current.assigned &&
        !current.ever_started &&
        current.ready_since !== null,
    )
    .sort((left, right) => {
      const idle = (left.ready_since ?? "").localeCompare(right.ready_since ?? "");
      return idle !== 0 ? idle : left.id.localeCompare(right.id);
    })
    .map((current) => ({
      node_id: current.id,
      node_title: current.title,
      idle_since: current.ready_since as string,
      on_critical_path: state.critical_path.includes(current.id),
    }));
  const changes = events
    .filter((event) => event.seq > since)
    .slice(-50)
    .map((event) => ({
      seq: event.seq,
      actor: event.actor,
      type: event.type,
      one_liner: oneLiner(event, state),
    }));
  return {
    summary: {
      counts_by_state: counts,
      critical_path_node_ids: [...state.critical_path],
      pending_approvals: pending,
      ready_unassigned: ready,
    },
    changes_since: changes,
    cursor: String(state.seq),
  };
}
