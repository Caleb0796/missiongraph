import type { Ev, Event, EvType, Handoff, NodeState, TaskNode } from "./events.js";

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphValidationError";
  }
}

export interface GraphNode extends TaskNode {
  availability: "ready" | "blocked" | null;
  ready_since: string | null;
  ever_started: boolean;
  assigned: boolean;
  pause_requested: boolean;
}

export interface GraphEdge {
  id: string;
  upstream: string;
  downstream: string;
  kind: "depends" | "conflicts";
}

export interface Approval {
  id: string;
  node_id: string;
  summary: string;
  created_at: string;
  created_seq: number;
  status: "pending" | "approved" | "rejected";
  diff_stats?: { lines_added: number; lines_removed: number; files: string[] };
  tests?: "green" | "red" | "none";
  resolved_at?: string;
  policy_ref?: string;
  rationale?: string;
  reason?: string;
}

export interface GraphState {
  v: 1;
  seq: number;
  nodes: Record<string, GraphNode>;
  edges: Record<string, GraphEdge>;
  tombstones: Record<string, { node: TaskNode; removed_at: string; removed_seq: number }>;
  approvals: Record<string, Approval>;
  policies: Record<string, { text: string; session_id: string; stated_at: string }>;
  annotations: Record<string, { actor: string; note: string; ts: string }[]>;
  journal: { actor: string; text: string; ts: string; seq: number }[];
  handoffs: Record<string, Handoff>;
  deviations: Record<
    string,
    { kind: "estimate" | "scope" | "other"; text: string; est_min?: number; actual_min?: number; ts: string }[]
  >;
  worker_logs: Record<string, string[]>;
  positions: Record<string, { x: number; y: number }>;
  selections: Record<string, string[]>;
  critical_path: string[];
}

export function initialState(): GraphState {
  return {
    v: 1,
    seq: 0,
    nodes: {},
    edges: {},
    tombstones: {},
    approvals: {},
    policies: {},
    annotations: {},
    journal: [],
    handoffs: {},
    deviations: {},
    worker_logs: {},
    positions: {},
    selections: {},
    critical_path: [],
  };
}

function cloneState(state: GraphState): GraphState {
  return structuredClone(state);
}

function fail(message: string): never {
  throw new GraphValidationError(message);
}

function node(state: GraphState, id: string): GraphNode {
  const found = state.nodes[id];
  if (!found) fail(`node ${id} does not exist`);
  return found;
}

function edge(state: GraphState, id: string): GraphEdge {
  const found = state.edges[id];
  if (!found) fail(`edge ${id} does not exist`);
  return found;
}

function addNode(state: GraphState, task: TaskNode): void {
  if (state.nodes[task.id] || state.tombstones[task.id]) fail(`node ${task.id} already exists`);
  state.nodes[task.id] = {
    ...structuredClone(task),
    availability: null,
    ready_since: null,
    ever_started: task.state !== "queued",
    assigned: task.state !== "queued",
    pause_requested: false,
  };
}

function removeNode(state: GraphState, id: string, event: Event): void {
  const existing = node(state, id);
  const { availability: _availability, ready_since: _readySince, ever_started: _everStarted, assigned: _assigned, pause_requested: _pauseRequested, ...task } = existing;
  state.tombstones[id] = { node: task, removed_at: event.ts, removed_seq: event.seq };
  delete state.nodes[id];
  delete state.positions[id];
  for (const [edgeId, value] of Object.entries(state.edges)) {
    if (value.upstream === id || value.downstream === id) delete state.edges[edgeId];
  }
}

function comparePaths(a: { weight: number; path: string[] }, b: { weight: number; path: string[] }): number {
  if (a.weight !== b.weight) return a.weight - b.weight;
  return b.path.join("\u0000").localeCompare(a.path.join("\u0000"));
}

function pathFrom(state: GraphState, start: string, memo: Map<string, { weight: number; path: string[] }>): { weight: number; path: string[] } {
  const cached = memo.get(start);
  if (cached) return cached;
  const current = state.nodes[start];
  if (!current || current.state === "done") return { weight: 0, path: [] };
  const downstream = Object.values(state.edges)
    .filter(
      (candidate) =>
        candidate.kind === "depends" &&
        candidate.upstream === start &&
        state.nodes[candidate.downstream]?.state !== "done",
    )
    .map((candidate) => candidate.downstream)
    .sort();
  let tail = { weight: 0, path: [] as string[] };
  for (const id of downstream) {
    const candidate = pathFrom(state, id, memo);
    if (comparePaths(candidate, tail) > 0) tail = candidate;
  }
  const result = { weight: current.estimate_min + tail.weight, path: [start, ...tail.path] };
  memo.set(start, result);
  return result;
}

export function remainingPathFrom(state: GraphState, start: string): { weight: number; path: string[] } {
  return pathFrom(state, start, new Map());
}

function computeCriticalPath(state: GraphState): string[] {
  let best = { weight: 0, path: [] as string[] };
  const memo = new Map<string, { weight: number; path: string[] }>();
  for (const id of Object.keys(state.nodes).sort()) {
    if (state.nodes[id]?.state === "done") continue;
    const candidate = pathFrom(state, id, memo);
    if (comparePaths(candidate, best) > 0) best = candidate;
  }
  return best.path;
}

function assertAcyclic(state: GraphState): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const successors = new Map<string, string[]>();
  for (const id of Object.keys(state.nodes)) successors.set(id, []);
  for (const value of Object.values(state.edges)) {
    if (value.kind === "depends") successors.get(value.upstream)?.push(value.downstream);
  }
  for (const values of successors.values()) values.sort();
  const visit = (id: string): void => {
    if (visiting.has(id)) fail(`dependency cycle includes node ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of successors.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...successors.keys()].sort()) visit(id);
}

function refreshDerived(state: GraphState, ts: string): void {
  for (const id of Object.keys(state.nodes).sort()) {
    const current = state.nodes[id];
    if (!current) continue;
    if (current.state !== "queued") {
      current.availability = null;
      current.ready_since = null;
      continue;
    }
    const blocked = Object.values(state.edges).some(
      (candidate) =>
        candidate.kind === "depends" &&
        candidate.downstream === id &&
        state.nodes[candidate.upstream]?.state !== "done",
    );
    const next = blocked ? "blocked" : "ready";
    if (next === "ready" && current.availability !== "ready") current.ready_since = ts;
    if (next === "blocked") current.ready_since = null;
    current.availability = next;
  }
  state.critical_path = computeCriticalPath(state);
}

const allowedTransitions: Record<NodeState, readonly NodeState[]> = {
  queued: ["running", "paused"],
  running: ["review", "failed", "paused"],
  review: ["done", "running"],
  done: [],
  failed: ["running", "paused"],
  paused: ["queued", "running", "failed"],
};

function transition(target: GraphNode, from: NodeState, to: NodeState): void {
  if (target.state !== from) fail(`node ${target.id} is ${target.state}, not ${from}`);
  if (!allowedTransitions[from].includes(to)) fail(`invalid node transition ${from} -> ${to}`);
  target.state = to;
  if (to !== "queued") target.assigned = true;
  if (to === "running" || to === "review" || to === "done" || to === "failed") target.ever_started = true;
  if (to !== "paused") target.pause_requested = false;
}

function requirePolicy(event: Ev<"APPROVED"> | Ev<"REJECTED">): void {
  if (event.actor === "browser_agent" && !event.payload.policy_ref) {
    fail(`${event.type} by browser_agent requires policy_ref`);
  }
}

function resolveApproval(state: GraphState, event: Ev<"APPROVED"> | Ev<"REJECTED">): void {
  requirePolicy(event);
  const approval = state.approvals[event.payload.approval_id];
  if (!approval || approval.status !== "pending") fail(`approval ${event.payload.approval_id} is not pending`);
  if (approval.node_id !== event.payload.node_id) fail("approval node_id does not match");
  const target = node(state, event.payload.node_id);
  if (target.state !== "review") fail(`node ${target.id} is not in review`);
  if (event.payload.policy_ref && !state.policies[event.payload.policy_ref]) {
    fail(`policy ${event.payload.policy_ref} does not exist`);
  }
  approval.status = event.type === "APPROVED" ? "approved" : "rejected";
  approval.resolved_at = event.ts;
  if (event.payload.policy_ref) approval.policy_ref = event.payload.policy_ref;
  if (event.type === "APPROVED") {
    if (event.payload.rationale) approval.rationale = event.payload.rationale;
    target.state = "done";
  } else {
    if (event.payload.reason) approval.reason = event.payload.reason;
    target.state = "running";
    target.ever_started = true;
  }
}

function apply(state: GraphState, event: Event): void {
  switch (event.type) {
    case "TASK_ADDED":
      addNode(state, event.payload.node);
      break;
    case "TASK_REMOVED":
      removeNode(state, event.payload.node_id, event);
      break;
    case "TASK_SPLIT": {
      const parent = node(state, event.payload.parent_id);
      if (event.payload.children.length === 0) fail("TASK_SPLIT requires at least one child");
      const childIds = new Set(event.payload.children.map((child) => child.id));
      if (childIds.size !== event.payload.children.length) fail("TASK_SPLIT child ids must be unique");
      const incident = new Map(
        Object.values(state.edges)
          .filter((value) => value.upstream === parent.id || value.downstream === parent.id)
          .map((value) => [value.id, value]),
      );
      const seen = new Set<string>();
      for (const remap of event.payload.edge_remap) {
        if (seen.has(remap.edge_id)) fail(`edge ${remap.edge_id} is remapped twice`);
        if (!incident.has(remap.edge_id)) fail(`edge ${remap.edge_id} is not incident to ${parent.id}`);
        if (!childIds.has(remap.new_target)) fail(`remap target ${remap.new_target} is not a split child`);
        seen.add(remap.edge_id);
      }
      removeNode(state, parent.id, event);
      for (const child of event.payload.children) addNode(state, child);
      for (const remap of event.payload.edge_remap) {
        const original = incident.get(remap.edge_id);
        if (!original) continue;
        state.edges[original.id] = {
          ...original,
          upstream: original.upstream === parent.id ? remap.new_target : original.upstream,
          downstream: original.downstream === parent.id ? remap.new_target : original.downstream,
        };
      }
      assertAcyclic(state);
      break;
    }
    case "EDGE_ADDED":
      if (state.edges[event.payload.edge_id]) fail(`edge ${event.payload.edge_id} already exists`);
      node(state, event.payload.upstream);
      node(state, event.payload.downstream);
      if (event.payload.upstream === event.payload.downstream && event.payload.kind === "depends") {
        fail("a dependency cannot connect a node to itself");
      }
      state.edges[event.payload.edge_id] = {
        id: event.payload.edge_id,
        upstream: event.payload.upstream,
        downstream: event.payload.downstream,
        kind: event.payload.kind,
      };
      assertAcyclic(state);
      break;
    case "EDGE_REMOVED":
      edge(state, event.payload.edge_id);
      delete state.edges[event.payload.edge_id];
      assertAcyclic(state);
      break;
    case "DISPATCHED": {
      const target = node(state, event.payload.node_id);
      if (target.state !== "queued" || target.availability !== "ready" || target.assigned) {
        fail(`node ${target.id} is not ready and unassigned`);
      }
      target.assigned = true;
      break;
    }
    case "RETRY_REQUESTED": {
      const target = node(state, event.payload.node_id);
      if (target.state !== "failed") fail(`node ${target.id} is not failed`);
      target.assigned = true;
      break;
    }
    case "PAUSE_REQUESTED": {
      const target = node(state, event.payload.node_id);
      if (!(["queued", "running", "failed"] as NodeState[]).includes(target.state)) {
        fail(`node ${target.id} cannot be paused from ${target.state}`);
      }
      target.pause_requested = true;
      break;
    }
    case "RESUME_REQUESTED": {
      const target = node(state, event.payload.node_id);
      if (target.state !== "paused") fail(`node ${target.id} is not paused`);
      break;
    }
    case "APPROVED":
    case "REJECTED":
      resolveApproval(state, event);
      break;
    case "POLICY_STATED":
      if (state.policies[event.payload.policy_ref]) fail(`policy ${event.payload.policy_ref} already exists`);
      state.policies[event.payload.policy_ref] = {
        text: event.payload.text,
        session_id: event.payload.session_id,
        stated_at: event.ts,
      };
      break;
    case "ANNOTATED":
      if (!state.nodes[event.payload.target_id] && !state.edges[event.payload.target_id]) {
        fail(`annotation target ${event.payload.target_id} does not exist`);
      }
      (state.annotations[event.payload.target_id] ??= []).push({
        actor: event.actor,
        note: event.payload.note,
        ts: event.ts,
      });
      break;
    case "JOURNAL_NOTE":
      state.journal.push({ actor: event.actor, text: event.payload.text, ts: event.ts, seq: event.seq });
      break;
    case "NODE_STATE_CHANGED":
      transition(node(state, event.payload.node_id), event.payload.from, event.payload.to);
      break;
    case "PAUSE_ACKED": {
      const target = node(state, event.payload.node_id);
      if (!target.pause_requested) fail(`node ${target.id} has no pending pause request`);
      if (!(["queued", "running", "failed"] as NodeState[]).includes(target.state)) {
        fail(`node ${target.id} cannot acknowledge a pause from ${target.state}`);
      }
      target.state = "paused";
      target.assigned = true;
      target.pause_requested = false;
      break;
    }
    case "WORKER_LOG": {
      node(state, event.payload.node_id);
      const lines = [...(state.worker_logs[event.payload.node_id] ?? []), ...event.payload.lines];
      state.worker_logs[event.payload.node_id] = lines.slice(-200);
      break;
    }
    case "HANDOFF_FILED": {
      const target = node(state, event.payload.node_id);
      if (target.state !== "running" && target.state !== "review") {
        fail(`node ${target.id} cannot file a handoff from ${target.state}`);
      }
      target.state = "review";
      target.ever_started = true;
      state.handoffs[target.id] = structuredClone(event.payload.handoff);
      break;
    }
    case "DEVIATION_NOTED":
      node(state, event.payload.node_id);
      (state.deviations[event.payload.node_id] ??= []).push({
        kind: event.payload.kind,
        text: event.payload.text,
        ...(event.payload.est_min === undefined ? {} : { est_min: event.payload.est_min }),
        ...(event.payload.actual_min === undefined ? {} : { actual_min: event.payload.actual_min }),
        ts: event.ts,
      });
      break;
    case "APPROVAL_CREATED": {
      const target = node(state, event.payload.node_id);
      if (target.state !== "review") fail(`node ${target.id} is not in review`);
      if (state.approvals[event.payload.approval_id]) fail(`approval ${event.payload.approval_id} already exists`);
      if (Object.values(state.approvals).some((approval) => approval.node_id === target.id && approval.status === "pending")) {
        fail(`node ${target.id} already has a pending approval`);
      }
      state.approvals[event.payload.approval_id] = {
        id: event.payload.approval_id,
        node_id: target.id,
        summary: event.payload.summary,
        created_at: event.ts,
        created_seq: event.seq,
        status: "pending",
        ...(event.payload.diff_stats === undefined ? {} : { diff_stats: structuredClone(event.payload.diff_stats) }),
        ...(event.payload.tests === undefined ? {} : { tests: event.payload.tests }),
      };
      break;
    }
    case "NODE_MOVED":
      node(state, event.payload.node_id);
      state.positions[event.payload.node_id] = { x: event.payload.x, y: event.payload.y };
      break;
    case "SELECTION_CHANGED":
      for (const id of event.payload.selected) {
        if (!state.nodes[id] && !state.edges[id]) fail(`selection target ${id} does not exist`);
      }
      state.selections[event.payload.client_id] = [...event.payload.selected];
      break;
  }
}

export function reduceEvent(state: GraphState, event: Event): GraphState {
  if (event.seq !== state.seq + 1) fail(`expected seq ${state.seq + 1}, received ${event.seq}`);
  const next = cloneState(state);
  apply(next, event);
  next.seq = event.seq;
  refreshDerived(next, event.ts);
  return next;
}

export function fold(events: readonly Event[]): GraphState {
  let state = initialState();
  for (const event of events) state = reduceEvent(state, event);
  return state;
}

export function isDependencyMutation(type: EvType): boolean {
  return type === "EDGE_ADDED" || type === "EDGE_REMOVED" || type === "TASK_REMOVED" || type === "TASK_SPLIT";
}
