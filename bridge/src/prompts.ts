import type { MissionEvent, Snapshot } from "./types.js";

function compactState(snapshot: Snapshot): unknown {
  return {
    cursor: snapshot.cursor,
    critical_path: snapshot.state.critical_path,
    nodes: Object.values(snapshot.state.nodes).map((node) => ({
      id: node.id,
      title: node.title,
      brief: node.brief,
      state: node.state,
      availability: node.availability,
      assigned: node.assigned,
      pause_requested: node.pause_requested,
    })),
    pending_approvals: Object.entries(snapshot.state.approvals)
      .filter(([, approval]) => approval.status === "pending")
      .map(([id, approval]) => ({ id, node_id: approval.node_id })),
    policy_refs: Object.keys(snapshot.state.policies),
  };
}

export function supervisorBrief(snapshot: Snapshot): string {
  return `MISSIONGRAPH SUPERVISOR

You are the scheduling brain for one MissionGraph project. The bridge is the hands: you decide, and it executes only the JSON actions you return. Incoming turns contain one self-contained structural event envelope or a JSON array of envelopes in FIFO order.
You have read-only repository context. Do not edit files, commit, spawn processes, use the network, or report events directly. Your ONLY output channel is the DECISION CONTRACT JSON block below; the bridge performs every mechanical action and report.

AUTOPILOT POLICY (binding defaults)
- Auto-retry a failed node at most once, after a 30-second backoff.
- Auto-dispatch only ready nodes on the CRITICAL PATH, with an automatic concurrency cap of 2.
- An explicit human/browser-agent DISPATCHED envelope bypasses that cap and may consume one additional slot (+1).
- NEVER approve or reject without a current human policy_ref carried in project state or the envelope. Do not infer policy from journal history.
- Conflicts edges are advisory and never auto-block. Do not merge worker branches.

DECISION CONTRACT
Your final message on EVERY turn, including this initialization turn, MUST be exactly one JSON object with no prose, Markdown, or code fence:
{"actions":[]}
The actions array may contain only these exact object shapes:
{"act":"spawn_worker","node_id":"...","brief":"..."}
{"act":"pause_worker","node_id":"..."}
{"act":"resume_worker","node_id":"..."}
{"act":"kill_worker","node_id":"..."}
{"act":"rebrief_worker","node_id":"...","message":"..."}
{"act":"note","text":"..."}
Return at most 10 actions. Brief, message, and note text strings must not exceed 16 KB. Return at most one spawn_worker per node in a turn.
Return {"actions":[]} when no mechanical action is warranted. Never invent actions or fields outside this contract.

COMPACT PROJECT STATE
${JSON.stringify(compactState(snapshot))}`;
}

export function eventEnvelope(event: MissionEvent): Record<string, unknown> {
  return {
    seq: event.seq,
    type: event.type,
    actor: event.actor,
    ...event.payload,
    summary: summary(event),
  };
}

function summary(event: MissionEvent): string {
  const nodeId = typeof event.payload.node_id === "string" ? event.payload.node_id : undefined;
  switch (event.type) {
    case "TASK_ADDED": {
      const node = event.payload.node as { id?: string; title?: string } | undefined;
      return `${event.actor} added task ${node?.title ?? node?.id ?? "unknown"}.`;
    }
    case "EDGE_ADDED":
      return `${event.actor} added ${String(event.payload.kind)} edge ${String(event.payload.upstream)}→${String(event.payload.downstream)}.`;
    case "EDGE_REMOVED":
      return `${event.actor} removed edge ${String(event.payload.edge_id)}.`;
    case "DISPATCHED":
      return `${event.actor} explicitly dispatched node ${nodeId ?? "unknown"}; bypass_cap=${String(event.payload.bypass_cap)}.`;
    case "RETRY_REQUESTED":
      return `${event.actor} requested retry of node ${nodeId ?? "unknown"} with guidance.`;
    case "PAUSE_REQUESTED":
      return `${event.actor} requested cooperative pause of node ${nodeId ?? "unknown"}.`;
    case "RESUME_REQUESTED":
      return `${event.actor} requested resume of node ${nodeId ?? "unknown"}.`;
    default:
      return `${event.actor} emitted ${event.type}${nodeId ? ` for node ${nodeId}` : ""}.`;
  }
}

export function workerBrief(nodeId: string, brief: string, repoPath: string): string {
  return `MISSIONGRAPH WORKER

Node ID: ${JSON.stringify(nodeId)}
Task brief: ${JSON.stringify(brief)}
Target repository: ${JSON.stringify(repoPath)}

Work only on this task in the provided isolated git worktree. Commit your completed changes. Never merge branches. Follow the repository's own instructions.

REPORTING IS REQUIRED AND NON-OPTIONAL
The bridge supplies MG_REPORT_URL, MG_REPORTER_CONFIG, MG_WORKER_ACTOR, and MG_NODE_ID in your environment. MG_REPORTER_CONFIG is a bridge-maintained 0600 curl config that is renewed before expiry. Never print or read it directly. Send reports with this exact transport (the Node expression supplies valid JSON on stdin and curl reads the authorization header from the config file without exposing the credential in process arguments):

node --input-type=module -e 'import {randomUUID} from "node:crypto"; process.stdout.write(JSON.stringify({actor:process.env.MG_WORKER_ACTOR,type:"NODE_STATE_CHANGED",payload:{node_id:process.env.MG_NODE_ID,from:"queued",to:"running",detail:"Worker started"},idem_key:randomUUID()}))' | curl --config "$MG_REPORTER_CONFIG" --fail --silent --show-error -X POST "$MG_REPORT_URL" -H "content-type: application/json" --data-binary @-

Report NODE_STATE_CHANGED queued→running before editing. Send WORKER_LOG tail chunks at meaningful progress points using the same curl transport and this body shape:
{"actor":"worker:<node_id>","type":"WORKER_LOG","payload":{"node_id":"<node_id>","lines":["human-readable progress"]},"idem_key":"<unique UUID>"}

On failure, report NODE_STATE_CHANGED running→failed with a useful detail and stop. On success, run authoritative tests, commit, then report in this order:
1. NODE_STATE_CHANGED running→review.
2. HANDOFF_FILED with exactly this CONTRACTS §2 shape, filled with real evidence:
{"actor":"worker:<node_id>","type":"HANDOFF_FILED","payload":{"node_id":"<node_id>","handoff":{"v":1,"summary":"prose summary first","files":["relative/path"],"commits":["git commit id"],"tests":"green|red|none","downstream_notes":"useful context","deviations":[],"artifacts":[]}},"idem_key":"<unique UUID>"}
3. APPROVAL_CREATED exactly once, with a prose summary, actual diff_stats, and test status.

Filing HANDOFF_FILED is part of task completion. Do not claim completion until the server accepts every required report.`;
}
