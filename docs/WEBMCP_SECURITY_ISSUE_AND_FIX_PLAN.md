# WebMCP security issue and fix plan

Suggested GitHub issue title: `security: harden the WebMCP → server → Codex execution trust chain`

Audit base: `268228dd1ab0847515d9e03f9a17a77536bbbe44` on `main`

Audit date: 2026-08-30 (America/Los_Angeles)

Scope: `app/src/webmcp`, browser capability handling, server auth/realtime/resource boundaries, and the downstream Codex bridge.

This document is a plan only. It does not authorize deployment, secret rotation, contract edits, or enabling the production bridge.

## Executive summary

MissionGraph currently has eight WebMCP-related security findings. The highest-impact chain is:

1. WebMCP-controlled task, annotation, policy, journal, guidance, and handoff text is treated as ordinary model context.
2. The Codex supervisor can turn that text into privileged actions.
3. Bridge validation accepts actions based mostly on shape and node existence; it does not prove that the triggering event and current graph state authorize the action.
4. A resulting worker receives arbitrary model-authored instructions with workspace write access and network access.

Production currently has `BRIDGE_ENABLED=0`, which contains the final worker-execution step. Keep it disabled until SEC-001 and SEC-002 pass their Definitions of Done. If a live test is unavoidable, use only a throwaway repository, a project-scoped API key with a hard spend cap, and no valuable credentials or data.

The separate dependency scan also found three high-severity production advisories in `fastify@5.6.2` and `ws@8.18.3`. These should be patched first because the server is already internet-facing.

## Threat model and security invariants

Treat the following as untrusted:

- every WebMCP input, including apparently human-authored policy text;
- all node titles/briefs, annotations, journal notes, approval summaries, worker logs, handoffs, artifact URLs, and `changes_since` prose;
- all model output, including syntactically valid `SupervisorDecision` JSON;
- `x-mg-actor`, URL parameters, browser storage, and every bearer token received from a client;
- cross-origin `Origin` headers and realtime connection counts.

Protect these assets:

- the target Git repository and its history;
- model/API credentials and spend;
- reporter, visitor, share, and realtime capabilities;
- the accuracy of actor attribution and approval history;
- availability of the Render service, SQLite database, and realtime fan-out;
- the browser agent's instruction hierarchy.

Required invariants after the fix:

1. Model output is never sufficient authorization for a privileged action.
2. The same agent being constrained cannot mint its own human-approval capability.
3. A visitor capability is never placed in an address bar, browser history, referrer, proxy log, WebSocket URL, or SSE URL.
4. Untrusted model-facing output is explicitly labeled and bounded.
5. Every externally reachable request has size, rate, concurrency, and lifetime limits.
6. A canceled WebMCP call cannot silently begin a new mutation after cancellation.
7. Audit actor labels are server-derived facts, not client assertions.

## Findings

### SEC-001 — Critical when the bridge is enabled: prompt injection can cross into privileged worker execution

Evidence:

- `bridge/src/prompts.ts:3-20` puts node titles and briefs directly in the supervisor prompt.
- `bridge/src/prompts.ts:53-60` spreads complete event payloads into the next supervisor turn.
- `bridge/src/prompts.ts:87-94` interpolates the model-selected worker brief into the worker's instruction prompt.
- `bridge/src/decision.ts:94-139` checks action shape, node existence, duplicate spawn, and text length, but not readiness, assignment, concurrency, the triggering event, or whether the brief equals a server-authorized brief.
- `bridge/src/codex.ts:120-140` launches the worker with workspace-write and `sandbox_workspace_write.network_access=true`.
- `bridge/src/codex.ts:60-73` passes `OPENAI_*` and `CODEX_*` variables to Codex child processes. The implementation has no test proving that commands executed by a compromised worker cannot read or relay those values.
- A local proof called `validateSupervisorDecision` with a blocked node and an attacker-controlled brief. It returned the action unchanged with an empty journal:

  ```json
  {"decision":{"actions":[{"act":"spawn_worker","node_id":"blocked","brief":"attacker-controlled instructions"}]},"journal":[]}
  ```

Impact: attacker-controlled graph content or indirect prompt injection can influence supervisor decisions, start work that policy did not authorize, consume model budget, modify a repository, and potentially expose credentials through worker commands or reports.

### SEC-002 — High: the human-approval guard is self-authorizable and actor attribution is forgeable

Evidence:

- `app/src/webmcp/tools.ts:960-989` lets the browser agent call `state_policy` and immediately mint the `policy_ref` that constrains the same browser agent.
- `server/src/http.ts:54-58` trusts the client-supplied `x-mg-actor` header and defaults a missing value to `human`.
- `server/src/reducer.ts:266-290` requires a policy only when the asserted actor is `browser_agent`.
- Session binding prevents use from a different session, but does not prove a human stated or approved the policy in the owning session.

Impact: a prompt-injected agent can invent a permissive policy and then approve/reject under it. Any visitor-token holder can also claim `human`, bypass the agent-policy rule, and create a false audit trail.

### SEC-003 — High: full-control visitor capabilities leak through URLs and have excessive lifetime/scope

Evidence:

- `app/src/transport/client.ts:1275-1289` creates a share URL containing the raw project token.
- `app/src/transport/client.ts:1117-1122` leaves valid share parameters in the address bar after connection; the existing clearing function is not called on this success path.
- `app/src/transport/client.ts:171-193`, `server/src/ws.ts:24-34`, and `server/src/ws.ts:67-75` put the same bearer token in WebSocket and SSE query strings.
- `app/src/transport/client.ts:219-227` stores the full bearer token in `localStorage`.
- Visitor tokens are stored in plaintext, have no expiration or revocation model, and grant read, mutation, export, dispatch, and approval powers.
- The live frontend response did not include `Content-Security-Policy` or `Referrer-Policy` during this audit.

Impact: browser history, screenshots, copied URLs, logs, extensions, XSS, or an accidentally forwarded link can yield persistent full project takeover.

### SEC-004 — High: internet-facing server dependencies have known vulnerabilities

`pnpm audit --prod` results:

| Package | Current | Minimum target | Advisories |
|---|---:|---:|---|
| `fastify` | 5.6.2 | 5.8.5 | GHSA-jx2c-rxcm-jvmq, GHSA-247c-9743-5963, GHSA-444r-cwp2-x5xf, GHSA-mrq3-vjjr-p77c |
| `ws` | 8.18.3 | 8.21.0 | GHSA-96hv-2xvq-fx4p, GHSA-58qx-3vcg-4xpx |

The two high Fastify findings are Content-Type parsing/body-validation bypasses. The high `ws` finding is memory-exhaustion DoS. Full audit additionally finds `vitest@3.2.4` affected by GHSA-5xrq-8626-4rwp when its UI server is exposed; update server and bridge to at least 3.2.6 even though this repository uses `vitest run`.

### SEC-005 — High: untrusted WebMCP output is unlabeled, oversized, and some mutating tools claim to be read-only

Evidence:

- `app/src/webmcp/registry.ts:147-186` adds `changes_since` to every tool result.
- Event prose can include policy text, notes, worker content, handoff summaries, titles, and other untrusted strings without truncation.
- No tool sets `untrustedContentHint`; therefore every envelope defaults to trusted despite the shared `changes_since` field.
- `get_node` returns task briefs, handoffs, deviations, annotations, and worker logs at `app/src/webmcp/tools.ts:1181-1246`.
- `focus`, `highlight_path`, `explain_overlay`, and `review_failures` carry `readOnlyHint: true` while changing camera, highlight, overlay, or other visible page state (`app/src/webmcp/tools.ts:1289-1404` and `app/src/webmcp/tools.ts:1568-1594`).
- Tool schemas and server validators have no `maxLength` or `maxItems` limits. `graph_digest`, `get_node`, `get_journal`, and 50 unbounded `changes_since` entries can greatly exceed Chrome's recommended 1.5K-character tool-output budget.

Official guidance says `untrustedContentHint` should mark user-generated/external output and that `readOnlyHint` can affect whether an agent asks for confirmation. Hints are useful signals, not authorization boundaries.

### SEC-006 — High: public clone, mutation, history, and realtime paths lack abuse limits

Evidence:

- `POST /api/clone-demo` is unauthenticated and clones the event stream into SQLite (`server/src/http.ts:452-495`).
- There is no per-IP or per-project rate limit for cloning, mutation, dispatch, export, WebSocket, or SSE.
- Input strings/arrays are unbounded (`server/src/events.ts:155-230`); batch count is capped, but payload size and repeated calls remain exploitable.
- Each append folds the full event history (`server/src/events.ts:801-829`), making sustained mutation cost grow with project history.
- Snapshot, export, replay, WebSocket, and SSE can return the full history. Realtime connections have no per-project/IP cap or idle timeout.

Impact: unauthenticated database growth; authenticated CPU, memory, storage, and model-spend exhaustion; oversized prompt-injection payloads; and connection exhaustion.

### SEC-007 — Medium: WebMCP execution cancellation is ignored by mutations

Evidence:

- `app/src/webmcp/registry.ts:147-167` receives `ToolExecuteOptions.signal` and passes it to definitions.
- No mission tool checks `signal.aborted`, calls `throwIfAborted`, or passes the signal to transport requests.
- Multi-request operations such as `add_task` can continue after the agent/user cancels and can partially apply.

Impact: the user agent can report a canceled call while MissionGraph continues to mutate state or spend resources.

### SEC-008 — Medium: browser/realtime defense-in-depth headers and origin checks are missing

Evidence:

- `app/vercel.json` contains only a rewrite.
- The audited live frontend had HSTS but no CSP, `Referrer-Policy`, explicit `Permissions-Policy`, `Origin-Agent-Cluster`, `X-Content-Type-Options`, or anti-framing policy.
- `server/src/ws.ts:24-44` authenticates the WebSocket token but does not validate `Origin` against `ALLOWED_ORIGINS`.
- The audited live API response did not include HSTS or the above security headers.

Impact: a token leak has a larger blast radius; clickjacking and script-injection defenses are weaker; WebSocket connections do not receive the same cross-origin policy as HTTP mutations.

## Fix plan

Follow `AGENTS.md` and `GOAL_PLAN.md`. Execute one security milestone at a time and commit only after its Definition of Done passes. Do not deploy, enable the bridge, merge to `main`, rotate credentials, add dependencies, or edit frozen `docs/CONTRACTS.md` without the corresponding human/orchestrator approval.

### S0 — Containment and contract gate

1. Keep `BRIDGE_ENABLED=0` in production.
2. Create a short security contract addendum proposal in `PROGRESS.md`; do not edit `docs/CONTRACTS.md` yet. It must specify:
   - server-derived actor attribution;
   - UI-confirmed, session/project/action-bound human policy grants plus replay-safe execution nonces;
   - deterministic supervisor-action authorization;
   - short-lived share/realtime ticket semantics;
   - input/output/rate limits and error codes (`413`, `429`, `capability_expired`, `capability_replayed`).
3. Ask the human/orchestrator to ratify that addendum before S2, S3, or S4 changes any frozen interface.
4. Record an explicit threat model and the production containment state in `PROGRESS.md`.

Definition of Done:

- Production bridge remains disabled.
- The proposed contract covers all eight findings and preserves the three demo scenarios.
- No secret or live capability appears in the proposal or tests.

Suggested commit after ratification: `docs: define WebMCP security boundaries`

### S1 — Patch known vulnerable dependencies

1. In `server/package.json`, update exact versions to at least `fastify@5.8.5`, `ws@8.21.0`, and `vitest@3.2.6`.
2. In `bridge/package.json`, update `vitest` to at least 3.2.6.
3. Regenerate only the affected lockfiles with pnpm; do not hand-edit them.
4. Run the complete server and bridge test/build gates.
5. Run both full and production dependency audits in all three packages.

Definition of Done:

- `pnpm audit --prod` reports no known vulnerability in app, server, or bridge.
- Full `pnpm audit` reports no known vulnerability, or any remaining dev-only advisory is explicitly risk-accepted by the human.
- Every app test passes (baseline: 50/50), and build/lint pass.
- Every server test passes (baseline: 30/30), and build passes.
- Every bridge test passes (baseline: 41/41), and build passes.

Suggested commit: `fix(security): patch exposed server dependencies`

### S2 — Make human authorization non-self-issued and actor attribution server-derived

1. Change `state_policy` into a staging operation:
   - tool call stores only a pending policy draft;
   - visible native UI shows exact text, scope, expiry, and allowed approval actions;
   - only a real UI confirmation mints a random server-side policy grant;
   - absence or denial returns a non-mutating result.
2. Bind the grant to project, server-side browser session, policy-text hash, permitted operation(s), expiry, and an explicit maximum-use budget that preserves the multi-approval demo. Bind each consequential use to a unique nonce/idempotency key; reject replay, foreign session/project, modified text, exhausted grants, and expiry.
3. Stop treating `x-mg-actor` as authority. Derive the actor from the authenticated endpoint/capability. If the header remains for compatibility, store it only as `claimed_actor` and never branch authorization on it.
4. Require a valid human-presence capability for every approval/rejection path, including calls claiming to be human. Preserve the policy text/ref in the audit ledger.
5. Add a visible confirmation path for other consequential actions: real dispatch, pause/resume, destructive graph confirmation, and any `brief_override` that can reach a worker. A preview token that the same agent can confirm is concurrency protection, not proof of human consent.

Required tests:

- A WebMCP call alone cannot mint a usable policy grant.
- `x-mg-actor: human` without a valid grant cannot bypass policy enforcement.
- Foreign-session/project, expired, modified, exhausted, and replayed grants/uses fail without appending an event.
- The accepted event records server-derived actor, policy text/ref, request origin, and confirmation timestamp.
- Existing native-human and browser-agent scenario beats remain visible and functional.

Suggested commit: `fix(security): bind agent approvals to human presence`

### S3 — Put a deterministic authorization boundary after the supervisor model

1. Replace model-authored `spawn_worker.brief` with a non-authoritative action such as `{act:"spawn_worker", node_id}`. The bridge, not the model, must fetch the canonical node/execution profile.
2. Pass the triggering envelope set into `validateSupervisorDecision`. Enforce, in code:
   - explicit dispatch only for that exact node and valid confirmation capability;
   - automatic spawn only for a ready, unassigned critical-path node within the configured concurrency cap;
   - no spawn for blocked, running, review, done, group, tombstoned, or already tracked nodes;
   - retry only after the stored retry/backoff policy permits it;
   - pause/resume only in matching states;
   - rebrief only for workers in the computed structural blast radius;
   - kill only for an explicit server-authorized reason;
   - notes have bounded, non-secret content.
3. Do not let the LLM supply arbitrary worker instructions. For the public demo, map dispatchable nodes to reviewed, immutable execution templates and typed parameters. For a general product, isolate each tenant's repository, credentials, budget, and egress before permitting user-authored code tasks.
4. Delimit all untrusted prompt data and state that it is data, but do not count prompt wording as the security control.
5. Disable worker network access by default. Add a test command proving worker-executed processes cannot read model/API secrets. If Codex tool commands inherit `OPENAI_*`/`CODEX_*`, move model authentication behind a broker/credential boundary before enabling workers. Replace network-based worker reporting with a narrowly scoped local transport or an egress allowlist if necessary.
6. Separate the global seed-import administrator credential from project-bound supervisor reporter credentials. Remove the global reporter-token fallback from project report/credential routes.

Required adversarial tests:

- Injection strings in title, brief, annotation, journal, guidance, handoff, log, and artifact URL cannot create an unauthorized action.
- The local blocked-node proof now returns no accepted action and a security journal entry.
- A syntactically perfect malicious `SupervisorDecision` is rejected unless the event/state capability authorizes it.
- Worker shell commands cannot observe `OPENAI_API_KEY`, `REPORTER_TOKEN`, global supervisor credentials, or another node's reporter credential.
- No network egress is available except the explicitly tested reporting path.

Suggested commits:

- `fix(security): validate supervisor actions against graph policy`
- `fix(security): isolate worker credentials and egress`

### S4 — Replace bearer URLs with scoped, expiring capability exchange

1. Replace `mg_token` share links with random, single-use, short-lived share codes. Default shared access to read-only; require an explicit UI choice and warning for write/dispatch/approve scope.
2. Exchange the code through an authenticated POST, rotate it on success, and remove it from the address bar synchronously before any network request or rendering that can initiate a request.
3. Prefer same-origin frontend/API routing and a `Secure; HttpOnly; SameSite=Strict` session cookie. If the deployment must stay cross-origin, keep the access token in memory/session storage, use a tightly scoped refresh mechanism, and document the residual XSS risk; do not keep a permanent full-control token in `localStorage`.
4. Mint one-time, short-lived realtime tickets through an authenticated HTTPS request. Put only the ticket—not the visitor token—in WebSocket/SSE URLs. Bind it to project, session, origin, transport, and expiry.
5. Hash visitor/share/realtime tokens at rest, add expiry/revocation/rotation, and prevent raw token values from entering application logs.
6. Split read, mutate, dispatch, approve, export, and share scopes. The browser receives only the scopes needed for its current mode.

Required tests:

- Raw visitor tokens never appear in `window.location`, history state, copied links, WebSocket URLs, SSE URLs, logs, or error text.
- Share/realtime codes are single-use, expire, are origin/project/session bound, and fail closed on replay.
- Read-only shares cannot mutate, dispatch, approve, export, or mint broader capabilities.
- Stored database values cannot be replayed directly as bearer tokens.

Suggested commit: `fix(security): exchange scoped capabilities without URL secrets`

### S5 — Bound and label every WebMCP data flow

1. Because `changes_since` is attached to every result, set `untrustedContentHint: true` on every registered MissionGraph tool, including contextual tools and compatibility results once connected. Alternatively, remove untrusted prose from the shared envelope and prove per-tool trust before using a narrower annotation.
2. Keep `readOnlyHint: true` only on operations that do not change server or visible page state. Recommended split:
   - pure `list_failures`/read tools remain read-only;
   - `focus`, `highlight_path`, `explain_overlay`, and camera-driving failure review are navigation/display actions and must not claim read-only behavior.
3. Define centralized limits and use the same constants in WebMCP schemas, client validation, server validation, reporter validation, and bridge decision validation. Initial values for review:
   - identifiers 128 chars;
   - title 120; tag 40; at most 20 tags;
   - brief/guidance/policy/note/reason/summary 2,000 chars each;
   - worker log line 500, at most 20 lines/event;
   - handoff files/commits/deviations/artifacts 50 each;
   - plan tasks 50; split children 20; focus IDs 50;
   - request body 256 KiB; batch 100 events;
   - common tool output target 1.5K chars, hard ceiling 8 KiB with pagination/continuation.
4. Return concise structural facts. Truncate untrusted prose with an explicit `truncated: true` marker and stable continuation cursor; never echo full input in success/error summaries.
5. Validate artifact URLs to an allowlist of `https:` (and an intentionally supported internal scheme, if any). Never return credentials embedded in URLs.
6. Add output-injection eval fixtures containing instruction-like text, Unicode controls, oversized repetition, JSON-looking text, and fake tool results.

Definition of Done:

- `getTools()` exposes correct `readOnlyHint` and `untrustedContentHint` values in native WebMCP and all registry fallback tiers.
- Max+1 inputs fail identically in browser and server without appending events.
- All tool outputs respect the documented ceiling and preserve required `cursor`/`changes_since` semantics.
- Chrome stable and the ChatGPT in-app browser still pass the compatibility gate.

Suggested commit: `fix(security): bound and label WebMCP content`

### S6 — Add abuse controls and scalable history boundaries

1. Set Fastify `bodyLimit` explicitly and reject unsupported/malformed Content-Type before route logic.
2. Add rate/concurrency quotas for clone, mutation, dispatch, approval, export, snapshot/history, reporter, WebSocket, and SSE. Return `429` with `Retry-After`. Minimum public-demo policy for review:
   - clone: 3/IP/hour;
   - mutation: 60/project/minute with a burst cap;
   - dispatch: 3/project/day and 1 active explicit dispatch;
   - realtime: 2 connections/project and a conservative IP cap;
   - export/history: 5/project/minute.
3. This likely benefits from `@fastify/rate-limit`; adding it requires prior user approval with an exact version. If approval is not granted, use an edge/provider rate limit plus SQLite-backed counters rather than a process-local map that resets on restart.
4. Add visitor-project TTL and garbage collection, event-count/storage quotas, paginated export/history, replay caps, heartbeat/idle timeouts, and backpressure handling.
5. Stop folding the complete event stream for every append. Maintain a versioned materialized state/snapshot or enforce a hard event cap until incremental folding is implemented.
6. Validate WebSocket `Origin` against `ALLOWED_ORIGINS`; reject missing origin for browser-facing endpoints unless an explicitly authenticated non-browser client path is used.

Required tests:

- Clone/mutation/dispatch/connection floods reach a deterministic `429` without unbounded DB or listener growth.
- Oversized body gets `413`; oversized field/array gets `400`; neither writes an event.
- Realtime rejects disallowed origins, excessive connections, stale tickets, oversized frames, and slow consumers.
- History work remains bounded at the configured project maximum.

Suggested commit: `fix(security): limit public API and realtime abuse`

### S7 — Honor cancellation and make mutations atomic

1. Call `signal.throwIfAborted()` before validation, before queueing, and immediately before an irreversible request.
2. Propagate the signal into fetch/history operations and queued mutation contexts. Remove canceled queued work before it starts.
3. Convert remaining multi-request graph operations, especially `add_task`, into one validated atomic batch.
4. Define the commit boundary: if the server committed before cancellation was observed, record and surface the committed result on reconnect rather than silently retrying or pretending it did not happen.
5. Add idempotency-status/reconciliation only if required by the ratified contract; never auto-repeat a consequential mutation after an ambiguous network failure.

Required tests:

- Pre-aborted and queue-aborted calls append zero events.
- Cancellation between validation and send appends zero events.
- An ambiguous post-send cancellation reconciles to exactly one event/batch.
- `add_task` is all-or-nothing under edge validation failure, conflict, cancellation, and 409.

Suggested commit: `fix(security): honor WebMCP cancellation atomically`

### S8 — Deploy browser/API security headers and verify the real path

1. Add frontend headers in `app/vercel.json`, testing a policy equivalent to:
   - `Content-Security-Policy`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://missiongraph.onrender.com wss://missiongraph.onrender.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
   - `Referrer-Policy: no-referrer`;
   - `Permissions-Policy: tools=(self)`;
   - `Origin-Agent-Cluster: ?1`;
   - `X-Content-Type-Options: nosniff`.
2. Narrow CSP further if runtime testing shows inline styles can be removed. Do not weaken `script-src` with `unsafe-inline` or `unsafe-eval`.
3. Add appropriate API HSTS and `nosniff` at the application or edge. Keep CORS origin allowlisting fail-closed and add WebSocket Origin parity.
4. Deploy only after S1-S7 pass. Test a fresh identity, a shared read-only identity, native WebMCP in ChatGPT, flagged Chrome stable, WS reconnect, SSE fallback, and the three demo scenarios.
5. Rotate any visitor/share/reporter/admin/model credentials that may have appeared in old links or logs. This is a human-controlled production action.

Definition of Done:

- Live response headers match the intended policy.
- No valid capability appears in the address bar, browser history, network URLs, Vercel/Render access logs, console, or screenshots.
- Native WebMCP registration remains available in origin-isolated documents.
- All automated gates and manual scenario beats pass after deployment.

Suggested commit: `fix(security): enforce browser and realtime origin policy`

## Final release gate

Do not mark the issue fixed until all of the following are true:

- All S0-S8 Definitions of Done pass.
- `git diff --check` is clean and the complete diff is reviewed hunk by hunk.
- Every changed symbol's callers are searched by exact name, alias/substring, import path, and `git log -S` where relevant.
- App tests/build/lint, server tests/build, and bridge tests/build pass.
- Full and production dependency audits pass or have explicit human risk acceptance.
- Security regression tests cover prompt injection, actor spoofing, self-minted policy, token leakage/replay, limits, origin checks, and cancellation.
- The ChatGPT in-app browser and flagged Chrome stable pass the native WebMCP gate.
- Production bridge is enabled only after a human reviews the security evidence, target repository isolation, worker egress, and spend cap.

## Official references

- WebMCP specification, Security and Privacy Considerations: https://webmachinelearning.github.io/webmcp/#security-and-privacy-considerations
- Chrome WebMCP tool security guidance: https://developer.chrome.com/docs/ai/webmcp/secure-tools
- Chrome WebMCP security and permissions: https://developer.chrome.com/docs/ai/webmcp#security-and-permissions
- Fastify advisory GHSA-jx2c-rxcm-jvmq: https://github.com/advisories/GHSA-jx2c-rxcm-jvmq
- Fastify advisory GHSA-247c-9743-5963: https://github.com/advisories/GHSA-247c-9743-5963
- ws advisory GHSA-96hv-2xvq-fx4p: https://github.com/advisories/GHSA-96hv-2xvq-fx4p
- ws advisory GHSA-58qx-3vcg-4xpx: https://github.com/advisories/GHSA-58qx-3vcg-4xpx
- Vitest advisory GHSA-5xrq-8626-4rwp: https://github.com/advisories/GHSA-5xrq-8626-4rwp
