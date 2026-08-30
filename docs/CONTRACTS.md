# CONTRACTS.md — frozen interfaces v1 (2026-08-30)

**FROZEN.** Every track builds against these. No session edits this file; propose changes in PROGRESS.md notes → the orchestrator (Claude) amends and bumps the version. TypeScript-ish notation; code generates types from here.

## 1. Event (the spine — GOAL_PLAN §5/§13)

```ts
interface Ev<T extends EvType, P> {
  seq: number;            // server-assigned, monotonic per project
  project_id: string;
  ts: string;             // ISO 8601, server clock
  actor: "human" | "browser_agent" | "supervisor" | `worker:${string}`;
  type: T;
  payload: P;
  idem_key: string;       // client-generated UUID; server dedupes
}
```

### Event types & payloads

Structural (→ forwarded to supervisor as queue envelopes):
- `TASK_ADDED` { node: TaskNode }
- `TASK_REMOVED` { node_id, tombstone: true }
- `TASK_SPLIT` { parent_id, children: TaskNode[], edge_remap: {edge_id, new_target}[] }
- `EDGE_ADDED` { edge_id, upstream, downstream, kind: "depends"|"conflicts" }
- `EDGE_REMOVED` { edge_id }
- `DISPATCHED` { node_id, brief_override?: string, bypass_cap: boolean }
- `RETRY_REQUESTED` { node_id, guidance: string }
- `PAUSE_REQUESTED` / `RESUME_REQUESTED` { node_id }
- `APPROVED` / `REJECTED` { approval_id, node_id, policy_ref?: string, rationale?: string, reason?: string }
- `POLICY_STATED` { policy_ref, text, scope: "session", session_id }
- `ANNOTATED` { target_id, note }        // nodes and edges
- `JOURNAL_NOTE` { text }

From the fleet (via reporter API):
- `NODE_STATE_CHANGED` { node_id, from: NodeState, to: NodeState, detail?: string }
- `PAUSE_ACKED` { node_id }
- `WORKER_LOG` { node_id, lines: string[] }             // tail chunks, debounced
- `HANDOFF_FILED` { node_id, handoff: Handoff }
- `DEVIATION_NOTED` { node_id, kind: "estimate"|"scope"|"other", text, est_min?, actual_min? }
- `APPROVAL_CREATED` { approval_id, node_id, summary, diff_stats?: {lines_added, lines_removed, files: string[]}, tests?: "green"|"red"|"none" }

Cosmetic (logged, never queued; debounced to settled values):
- `NODE_MOVED` { node_id, x, y }
- `SELECTION_CHANGED` { client_id, selected: string[] }  // per client session

## 2. Domain objects

```ts
type NodeState = "queued"|"running"|"review"|"done"|"failed"|"paused";
// "ready"/"blocked" are DERIVED by the reducer, never stored.

interface TaskNode {
  id: string; title: string; brief: string;
  estimate_min: number; tags: string[];
  state: NodeState;                       // lifecycle only
}

interface Handoff {                       // versioned: v:1
  v: 1; summary: string;                  // prose FIRST (§13 readability rule)
  files: string[]; commits: string[];
  tests: "green"|"red"|"none";
  downstream_notes: string; deviations: string[];
  artifacts: {label, url}[];
}
```

## 3. WebMCP tool result envelope

Every tool's `execute` returns **a JSON string** (Chrome imperative API):

```ts
interface ToolResult {
  ok: boolean;
  data?: unknown;                         // tool-specific, prose-bearing
  error?: { code: string; message: string };
  preview?: { op_token: string; blast_radius: {stale: string[], pausing: string[]} }; // confirm-protocol step 1
  cursor: string;                         // latest seq as string
  changes_since: { seq, actor, type, one_liner: string }[];  // bounded ≤50
}
```

Cursor state is maintained per browser client by the wrapper; `graph_digest(since?)` overrides explicitly.

## 4. Server HTTP + WS

- Mutations: `POST /api/p/:project/mutations` — body `{type, payload, idem_key, base_seq?}`; 200 `{seq}`; 409 `{fresh_digest}` on stale `base_seq`. Auth: visitor project token (header `x-mg-token`).
- Reporter: `POST /api/p/:project/report` — body = fleet event sans seq/ts; idempotent by `idem_key`. Auth: bearer reporter token (distinct secret).
- Snapshot: `GET /api/p/:project/snapshot` → `{state, cursor}`.
- WS `GET /ws?project&from_seq&token`: server→client only: `{kind:"event", event}` | `{kind:"snapshot", ...}`. Client mutations always go over HTTP. SSE fallback mirrors WS.
- Clone: `POST /api/clone-demo` → fresh project from seed (per-visitor isolation, §13).

## 5. Supervisor queue envelope (server → codex supervisor)

One-line JSON via `codex queue`:
```json
{"seq":142,"type":"EDGE_ADDED","actor":"human","upstream":"audit-log","downstream":"payments",
 "summary":"Human added dependency audit-log→payments; payments is blocked until audit-log completes."}
```
Always self-contained: structured fields + one English `summary`. Graph rewires send `{type:"GRAPH_DIFF", ops:[...], base_seq, new_seq, stale:[...], summary}`.

## 6. Naming

- Worktree branches: `track/frontend`, `track/server`, `track/bridge`; merges to `main` only by the orchestrator after review.
- Tool names, event types, and field names above are FINAL — renames cost cross-track breakage.
