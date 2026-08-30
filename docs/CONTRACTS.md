# CONTRACTS.md — frozen interfaces v1.4 (2026-08-30)

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
- Clone: `POST /api/clone-demo` → fresh project from seed (per-visitor isolation, §13). The CLIENT persists project id + visitor token (localStorage) and reuses them across reloads until an explicit reset (v1.2).
- Batch mutations (v1.2): the mutations endpoint ALSO accepts `{batch: [{type, payload}, …], idem_key, base_seq?}` — applied atomically in order, all-or-nothing, single 409 on stale `base_seq`; response `{seqs: number[]}`. `plan_seed` MUST use this; ids in a batch are server-assigned (batch-local temp ids in payloads are remapped).
- CORS (v1.2): the server answers CORS for origins listed in env `ALLOWED_ORIGINS` (comma-separated; production includes the Vercel origin), allowing `content-type`, `x-mg-token`, `x-mg-session` headers on the API routes; preflight cached. Without a matching origin, no CORS headers (fail closed).
- Client 409 rule (v1.2): on 409, refresh state from `fresh_digest` and SURFACE the conflict (tool envelope `error.code="stale_mutation"`, UI toast); NEVER auto-repost the original mutation.
- Preview binding (v1.2): `op_token` records the cursor at preview time; a confirm call after the cursor advanced is rejected with `error.code="preview_stale"` + a fresh preview. Native-UI structural edits on non-idle targets go through the SAME preview/confirm dialog (parity with tools).
- Reporter credential issuance (v1.3): `POST /api/p/:project/reporter-credentials` — auth: the supervisor-scope bearer token; body `{actor: "worker:<node_id>" | "supervisor"}`; response `{token, actor, expires}` (project+actor-bound, 15-min TTL, renewable by re-calling). The bridge mints one per worker spawn and embeds it in the worker brief.
- JOURNAL_NOTE via reporter (v1.3): `/report` ACCEPTS `JOURNAL_NOTE` when the authenticated actor is `supervisor` (this is the §5b `note` action's transport); workers may not journal.
- Worker node binding (v1.4): a `worker:<node_id>` reporter credential may report node-scoped events (`NODE_STATE_CHANGED`, `PAUSE_ACKED`, `WORKER_LOG`, `HANDOFF_FILED`, `DEVIATION_NOTED`, `APPROVAL_CREATED`) ONLY for its own node: `payload.node_id` MUST equal the credential's bound node id, else 403. Supervisor-scope credentials are exempt from node binding.

## 5. Supervisor envelope delivery (server → codex supervisor) — v1.1, probe-verified

`codex queue` does NOT exist in CLI 0.144.6 (docs/PROBE.md). Delivery mechanism:
- The SERVER owns a FIFO of envelopes per project.
- Delivery = `codex exec resume <supervisor_thread_id> '<one-line JSON envelope>'` — at most ONE in-flight resume at a time; next envelope (or a batch, concatenated as a JSON array) goes out when the previous turn returns. Session memory persists across resumes (probe P3), so the supervisor accumulates project context.

Envelope (unchanged):
```json
{"seq":142,"type":"EDGE_ADDED","actor":"human","upstream":"audit-log","downstream":"payments",
 "summary":"Human added dependency audit-log→payments; payments is now blocked until audit-log completes."}
```
Always self-contained: structured fields + one English `summary`. Graph rewires send `{type:"GRAPH_DIFF", ops:[...], base_seq, new_seq, stale:[...], summary}`.

Deployment invariant (v1.4): exactly ONE bridge daemon per project. The bridge enforces this with an exclusive lock on its state file (second daemon exits with a clear error). Server-owned FIFO with delivery leases remains the target design; the current bridge-local queue is a RECORDED DEVIATION (PROGRESS.md M3). Delivery is at-least-once: the bridge persists its cursor after a successful supervisor turn and before executing actions, and all §5b actions are idempotent (`spawn_worker` for a node with a live worker is a no-op).

## 5b. Supervisor decision contract (supervisor turn → server) — v1.1

The supervisor's final message each turn is a JSON decision block. The server EXECUTES it mechanically (supervisor = brain, server = hands; C4 stays intact and every scheduling decision is an auditable recorded turn):

```ts
interface SupervisorDecision {
  actions: (
    | { act: "spawn_worker"; node_id: string; brief: string }      // server: git worktree add + codex exec (PROBE.md commands)
    | { act: "pause_worker" | "resume_worker" | "kill_worker"; node_id: string }
    | { act: "rebrief_worker"; node_id: string; message: string }  // server: exec resume to that worker's thread
    | { act: "note"; text: string }                                // → JOURNAL_NOTE event
  )[];
}
```
Worker sessions get their own thread ids; the server tracks `node_id → {thread_id, worktree}`. Workers report via the reporter API (§4), never through the supervisor.

## Changelog
- v1.4 (2026-08-30): from the M3 adversarial review — worker reporter credentials are node-bound (403 on cross-node reports); single-bridge-daemon deployment invariant + state-file lock; at-least-once delivery semantics with idempotent §5b actions.
- v1.3 (2026-08-30): from S5's integration gaps — reporter-credential issuance endpoint; JOURNAL_NOTE accepted from supervisor via /report.
- v1.2 (2026-08-30): from the M2 adversarial review — atomic batch mutations, ALLOWED_ORIGINS CORS, client clone persistence, 409 surface-don't-retry, cursor-bound op_token + native-UI confirm parity.
- v1.1 (2026-08-30): §5 delivery switched from `codex queue` (nonexistent in 0.144.6) to server-FIFO + `exec resume`, per docs/PROBE.md; added §5b supervisor decision contract.
- v1 (2026-08-30): initial freeze.

## 6. Naming

- Worktree branches: `track/frontend`, `track/server`, `track/bridge`; merges to `main` only by the orchestrator after review.
- Tool names, event types, and field names above are FINAL — renames cost cross-track breakage.
