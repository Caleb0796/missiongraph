# MissionGraph end-to-end test plan

**Version:** 2026-08-31
**System under test:** MissionGraph web app, event server, WebMCP surface, and Codex bridge
**Primary release target:** `https://missiongraph.vercel.app`
**Contract sources:** `GOAL_PLAN.md`, `docs/CONTRACTS.md`, `docs/webmcp-notes.md`

## 1. Purpose and release decision

This plan tests MissionGraph as a real user and browser agent experience, not just as isolated functions. It is intentionally adversarial around the places most likely to lose trust: mistaken mutations, stale state, invisible authorization, false execution history, reconnection, selection-dependent tools, and viewport constraints.

A release passes only when all of the following are true:

- Every P0 case is automated or executed manually with evidence and passes.
- Every P1 case selected for this release passes; any intentionally deferred P1 has an owner and explicit rationale.
- The three product journeys in `GOAL_PLAN.md` pass without fabricated events or hidden human actions.
- App, server, and bridge unit/integration suites, builds, and lint/type checks pass.
- Browser E2E produces no uncaught exception, unhandled rejection, or unexpected console error.
- Production is deployed from the exact tested worktree and passes the production smoke set.
- Test mutations use isolated visitor clones. The public seed project and another user's project are never changed.

Priority meanings:

- **P0:** release blocker; data integrity, security, WebMCP discovery, primary journey, or app availability.
- **P1:** important real-world usability/recovery behavior; release blocker unless explicitly waived.
- **P2:** valuable compatibility, resilience, or polish coverage.

Execution modes:

- **A:** automated in Vitest or Playwright-compatible browser automation.
- **N:** native WebMCP verification in the ChatGPT in-app browser or flagged stable Chrome.
- **M:** manual visual/usability check with screenshot and written observation.

## 2. Environments and evidence

### 2.1 Test environments

| Environment | Purpose | Data policy |
| --- | --- | --- |
| Isolated local server + local Vite app | destructive E2E, failure injection, concurrent clients, bridge | fresh temporary SQLite database and visitor clone per run |
| Headless Chromium | repeatable desktop/mobile UI and API orchestration | local isolated clone only |
| ChatGPT in-app browser | native WebMCP discovery, execution, and dynamic tool lifecycle | local clone when reachable; otherwise a fresh production clone |
| Flagged Chrome stable | browser implementation compatibility | fresh local or production clone |
| Vercel production | final read-only/safe smoke and one fresh-clone journey | never mutate the seed; record generated project ID |

Default viewports:

- Desktop: 1440 × 900.
- Laptop: 1280 × 720.
- Mobile: 390 × 844.
- Reduced motion: desktop with `prefers-reduced-motion: reduce`.

### 2.2 Required evidence per run

For each executed group, capture:

- source revision or dirty-worktree diff identity;
- app/server URLs, browser name/version, and viewport;
- test command and exit status;
- screenshot after each major journey and on every failure;
- browser console errors and failed network requests;
- project ID, initial cursor, final cursor, and event types for mutation journeys;
- WebMCP namespace, dynamic registration tier, discovered tool names, and tool result envelope;
- deployment URL/ID and production verification timestamp.

Evidence must describe observed behavior. Dry-run bridge output must retain its `DRY-RUN SIMULATION` label and must not be presented as real Codex execution.

## 3. Personas and state matrix

| Persona/state | User need | Main risks |
| --- | --- | --- |
| First-time judge | understand the graph and invoke an agent quickly | blank canvas, unclear first action, compatibility banner dead end |
| Returning operator | resume the same mission after reload | identity/token loss, duplicate session state, stale timeline |
| Shared-link recipient | open a mission link from another person | token leakage, invalid link handling, wrong-project mutation |
| Human operator | approve, reject, dispatch, pause, resume, split | invisible or replayable authorization, unclear blast radius |
| Browser agent | discover tools and safely mutate/read graph | bad schemas, stale tool context, duplicate tools, misleading success |
| Supervisor/worker bridge | turn confirmed dispatch into auditable work | duplicate workers, wrong node credentials, lost cursor, fabricated history |
| Mobile/keyboard user | inspect and operate without a large pointer viewport | inaccessible dialogs, clipped controls, focus traps, horizontal overflow |
| Offline/slow user | retain intent and recover after transport loss | silent failure, stale mutation, duplicate replay, permanent fixture fallback |

Every mutating journey is run from both a fresh state and, where applicable, a non-zero cursor with concurrent changes.

## 4. Detailed scenarios

### A. Bootstrap, identity, and project isolation

| ID | Pri | Mode | Preconditions and actions | Expected result |
| --- | --- | --- | --- | --- |
| A-01 | P0 | A | Clear site storage; open `/`; wait for bootstrap. | One visitor clone is created; app shows live mode, persists its identity, renders the graph and timeline, and does not mutate the source seed. |
| A-02 | P0 | A | Reload after A-01. | Same project identity is restored; no second clone; cursor/state are unchanged except legitimate server events. |
| A-03 | P0 | A | Open a second tab with the copied mission link. | Both tabs address the same project. The deliberately shared visitor capability is scrubbed from the recipient address bar after successful bootstrap and never appears in console or rendered text. |
| A-04 | P0 | A | Open a malformed/unknown mission URL or stored identity. | App rejects it safely, offers a recoverable path, and never displays another project or writes with a stale token. |
| A-05 | P1 | A | Delay `clone-demo` and snapshot responses. | Loading state is visible; controls do not execute against an uninitialized identity; bootstrap completes once. |
| A-06 | P0 | A | Make server unavailable on first load. | Fixture/failure state is honestly labeled; live execution is not claimed; recovery action is visible. |
| A-07 | P1 | A | Restore server after A-06 and trigger reconnect. | App establishes a fresh browser session, loads authoritative state, and removes stale recovery messaging. |
| A-08 | P0 | A | Trigger reset on an isolated clone and confirm. | Only the current visitor clone resets; local identity/session/selection are coherent; public seed is untouched. |
| A-09 | P1 | A | Start bootstrap, switch identity before its response returns. | Late response cannot overwrite the new active mission (`identity_changed` fencing). |
| A-10 | P0 | A | Call snapshot/mutation with missing, wrong, and cross-project tokens. | Server returns authorization errors and appends no events. |

### B. First-run comprehension and graph workspace

| ID | Pri | Mode | Preconditions and actions | Expected result |
| --- | --- | --- | --- | --- |
| B-01 | P1 | A/M | Open a fresh clone on desktop. | Mission title, live/fixture status, graph, PulseBar, timeline, and inspector affordance are legible above the fold. |
| B-02 | P1 | A | Inspect first-run agent prompt chips, dismiss, then reload. | Prompts appear at the intended scope, dismiss cleanly, and do not reappear unexpectedly. |
| B-03 | P0 | A/M | Inspect seeded graph at 1440×900 and 1280×720. | Nodes and edges render; labels are not hidden behind panels; graph can pan/zoom/fit without losing the workspace. |
| B-04 | P1 | A | Select each task and edge. | Selection is visually distinct; inspector shows the correct brief/handoff/deviation/decision/log data; no previous selection leaks. |
| B-05 | P1 | A | Use inspector tabs and timeline event buttons. | Tabs are keyboard operable; timeline jump focuses the referenced entity or explains why none exists. |
| B-06 | P1 | A/M | Feed long titles, briefs, tags, notes, and untrusted HTML-like text. | Text wraps/truncates predictably, remains plain text, and does not execute markup or break layout. |
| B-07 | P1 | A | Drag a node and reload. | Layout persistence follows product contract; graph data and timeline remain unchanged by visual movement. |
| B-08 | P1 | A | Connect valid nodes, attempt duplicate edge and cycle, then delete an edge. | Valid link is atomic; invalid graph operations are rejected with actionable feedback; structural deletion requires confirmation. |

### C. WebMCP compatibility and registration lifecycle

| ID | Pri | Mode | Preconditions and actions | Expected result |
| --- | --- | --- | --- | --- |
| C-01 | P0 | A | Open `/compat` with no WebMCP API. | Page reports unavailable truthfully, does not crash, and keeps retrying without an interval/listener leak. |
| C-02 | P0 | N | Open `/compat` in ChatGPT in-app browser. | WebMCP is detected; namespace and dynamic tier are shown; self-test lists `hello_missiongraph`. |
| C-03 | P0 | N | Execute `hello_missiongraph` through native `executeTool`. | Result is a concise JSON-serializable envelope containing truthful namespace/tier/project status. |
| C-04 | P0 | A/N | Exercise document and navigator namespace variants. | Runtime discovery uses the available implementation; no false negative from checking only one namespace. |
| C-05 | P0 | A/N | Exercise signal, `provideContext`, and static fallback tiers. | Registration succeeds once, cleanup is supported for the tier, and shipped behavior remains functionally equivalent. |
| C-06 | P0 | A | Inject WebMCP after initial render, then use compatibility retry. | Late API becomes detected and full tools register without reload. |
| C-07 | P0 | A/N | Call `getTools()` after registration. | Exactly one copy of every core tool exists; names/descriptions/schemas/annotations match contract. |
| C-08 | P0 | A/N | Execute representative tools with object input; simulate string-only compatibility. | Wrapper chooses compatible input form without double-executing a mutation. |
| C-09 | P0 | A/N | Change selected node from none → queued → failed → none. | Contextual tools change to the correct set; `toolchange` is observable where supported; removed tools are not callable. |
| C-10 | P0 | A | Remount registry and change selection repeatedly. | No duplicate names, stale closures, unbounded controllers, or duplicate event handlers. |
| C-11 | P1 | A | Force contextual registration to fail three times, then change selection. | Degraded state is visible and later retry can recover; core tools stay usable. |
| C-12 | P1 | A/M | Navigate `/tools`, refresh tools, select one, and inspect schema. | Console reflects current native registry and degrades honestly when unavailable. |

### D. Journey S1 — Genesis: brief to executable DAG

| ID | Pri | Mode | Preconditions and actions | Expected result |
| --- | --- | --- | --- | --- |
| D-01 | P0 | A/N | On a blank clone call `plan_seed` with 4–6 tasks, dependencies, and mission metadata. | One atomic DAG appears; result reports real event sequences/cursor; invalid partial graphs append nothing. |
| D-02 | P0 | A | At the HTTP transport seam, resend D-01's captured batch with the same client-generated idempotency key after a simulated response loss. | No duplicate tasks/edges; the server identifies the same committed operation. A second independent tool call is not treated as the retry. |
| D-03 | P1 | A/N | Add a human task in UI, then agent calls `add_task`. | Interleaved edits preserve both actors and chronology; graph remains acyclic. |
| D-04 | P0 | A/N | Call `link`/`unlink`; attempt missing node, self-link, duplicate, and cycle. | Valid edges change once; invalid operations return structured errors and no events. |
| D-05 | P1 | A/N | Annotate a node and an edge, then query node/journal. | Notes bind to exact target, preserve actor/timestamp, and appear in inspector/log. |
| D-06 | P0 | A/N | Call `graph_digest` and `get_critical_path`. | Counts, blockers, cursor, changed-since data, and longest ready path agree with authoritative folded state. |
| D-07 | P1 | A/N | Use `focus`, `highlight_path`, and `explain_overlay`. | Visual state changes after tool completion; result describes the final visible state, not intent only. |
| D-08 | P1 | A/N | Select a task, call `get_selection` and contextual explain/annotate. | Result references the selected entity at execution time and cannot mutate a previously selected node. |
| D-09 | P0 | A/N | Remove a task with incoming/outgoing edges; cancel once, confirm once. | Blast radius is exact; cancel appends nothing; confirmation applies one atomic structural event set. |

### E. Journey S2 — Flight: approvals and execution

| ID | Pri | Mode | Preconditions and actions | Expected result |
| --- | --- | --- | --- | --- |
| E-01 | P0 | A/N | Call `list_ready` on seeded and updated graphs. | Only dependency-satisfied queued tasks appear; order and reasons are deterministic. |
| E-02 | P0 | A/N | Call `list_pending_approvals`; inspect FlightPanel queue. | Tool and UI contain the same pending approvals, target IDs, risk/reason, and order. |
| E-03 | P0 | A/N | Agent calls `state_policy`; deny once and confirm once in visible UI. | Denial appends no policy/capability; confirmation records scoped policy and returns only after human action. |
| E-04 | P0 | A/N | Approve/reject under a valid policy; attempt wrong policy, expired grant, replay, and excess use. | Only exact permitted actions succeed; audit records confirmation and nonce; failures append nothing. |
| E-05 | P0 | A/N | Dispatch a ready task; cancel/deny once, then confirm. | Dispatch is staged visibly; no event/worker before confirmation; confirmed event is human-authored with authorization audit. |
| E-06 | P0 | A | Start bridge dry-run after E-05. | Bridge consumes dispatch once, creates one mock worker identity/worktree, persists cursor/state, and labels simulated output. |
| E-07 | P0 | A | Reporter transitions node queued → running → done with progress. | UI updates live through WebSocket/SSE; timeline actor and event type are correct; no visitor endpoint can forge reporter events. |
| E-08 | P1 | A/N | Pause and resume a running node through visible confirmation. | One-use capability binds to exact node/action; state and audit update only after confirmation. |
| E-09 | P1 | A/N | Mark a node failed; call `review_failures` and `retry_with_guidance`. | Failure context is complete; retry creates honest guidance/state transition without claiming execution. |
| E-10 | P1 | A/M | Let a worker become idle/stale. | Idle radar and catch-up messaging identify the real worker/node and offer a valid recovery path. |

### F. Journey S3 — Rewire: split a running task

| ID | Pri | Mode | Preconditions and actions | Expected result |
| --- | --- | --- | --- | --- |
| F-01 | P0 | A/N | Select running task `R`; open UI split or call `split_selected` with children and edge remaps. | Preview names parent, children, preserved/remapped edges, cursor, and all affected nodes. No mutation yet. |
| F-02 | P0 | A/N | Deny/cancel F-01. | Graph, cursor, timeline, and worker state are unchanged. |
| F-03 | P0 | A | After preview, mutate graph in a second session, then confirm old preview. | Server returns 409/stale; app refreshes and demands a new blast-radius review. |
| F-04 | P0 | A/N | Confirm a fresh preview. | Split/remap is atomic; parent becomes group/historical container as specified; no dangling or duplicate edges. |
| F-05 | P0 | A | Force invalid child ID, missing remap, cycle, duplicate child, and mixed-action batch. | Validation fails before append; no partial split or capability consumption. |
| F-06 | P1 | A | Observe bridge/supervisor after F-04. | Existing work is paused/rebriefed per contract; no second worker starts without confirmed dispatch. |
| F-07 | P1 | A/N | Inspect selection and contextual tools after split. | Parent/children are individually selectable; contextual tools match each state; old selected object is not retained. |
| F-08 | P1 | A/M | Fit graph after a 2–5 child split at desktop and laptop sizes. | Layout remains readable; critical path and timeline point to new structure accurately. |

### G. Realtime, concurrency, idempotency, and recovery

| ID | Pri | Mode | Preconditions and actions | Expected result |
| --- | --- | --- | --- | --- |
| G-01 | P0 | A | Append events while WebSocket is connected. | Each event folds once in sequence; cursor is monotonic and matches snapshot. |
| G-02 | P0 | A | Block/close WebSocket and allow SSE fallback. | UI reports transport state honestly and receives later events without reload or duplication. |
| G-03 | P1 | A | Drop all realtime transport, append events, then reconnect. | Catch-up fetches every missing event from last cursor and clears stale connection warnings. |
| G-04 | P0 | A | Reload during a staged confirmation and during a completed mutation response. | Unconfirmed action cannot execute after session loss; completed idempotent action is not duplicated. |
| G-05 | P0 | A | Two tabs mutate from the same base cursor. | First succeeds; second receives fresh digest/409 and prompts refresh instead of overwriting. |
| G-06 | P0 | A | Retry identical request after simulated response loss. | Server returns idempotent result; timeline has one logical mutation. |
| G-07 | P1 | A | Deliver events out of order/duplicated at client boundary. | Store refuses regression/duplication and converges on authoritative snapshot. |
| G-08 | P0 | A | Switch project while snapshot, realtime callback, and confirmation are pending. | Late callbacks are fenced by identity epoch and cannot mutate the new project or UI. |

### H. Security and negative boundaries

| ID | Pri | Mode | Preconditions and actions | Expected result |
| --- | --- | --- | --- | --- |
| H-01 | P0 | A | Probe visitor, agent, report, credential, export, and realtime routes without auth/wrong auth. | Correct 401/403 response; no state/event/credential leakage. |
| H-02 | P0 | A | Confirm a draft with wrong project/session/proof/kind/subject. | Capability is not issued or consumed; draft remains safely handled; no mutation. |
| H-03 | P0 | A | Replay, expire, deny, or exceed max uses for action/policy capability. | Deterministic capability error; event count unchanged. |
| H-04 | P0 | A | Use worker credential for another node or supervisor-only operation. | Request is rejected; node binding and actor attribution remain intact. |
| H-05 | P0 | A | Send reporter event through visitor mutation route and visitor event through reporter route. | Both are rejected; C5 provenance boundary remains enforceable. |
| H-06 | P0 | A | Use disallowed CORS origin and forged origin. | No permissive CORS response; confirmation audit records actual accepted origin/same-origin marker. |
| H-07 | P1 | A | Submit empty, oversized, wrong-type, unknown-key, NaN-like, and Unicode edge-case inputs. | Structured validation error; server stays responsive; no partial events. |
| H-08 | P0 | A/M | Insert `<script>`, event-handler HTML, Markdown links, control characters, and long agent prose. | UI renders inert text; URLs/tokens are not auto-exposed; no script or style injection. |
| H-09 | P0 | A | Inspect built assets, console, local storage shape, tool responses, address bar after share-link bootstrap, and app logs. | No `.env`, Vercel OIDC, reporter token, or confirmation grant leaks. The current visitor capability exists only in its required stored identity/request path and the explicitly copied share URL; the recipient URL is scrubbed after successful bootstrap. |

### I. Bridge lifecycle and restart behavior

| ID | Pri | Mode | Preconditions and actions | Expected result |
| --- | --- | --- | --- | --- |
| I-01 | P0 | A | Confirm a real server dispatch, then start dry-run bridge. | Bridge observes correct sequence and creates one mock worker for exact node. |
| I-02 | P0 | A | Restart bridge with persisted state/cursor. | No duplicate worker/worktree/credential; only unseen envelopes are processed. |
| I-03 | P0 | A | Deliver duplicate dispatch and repeated envelopes. | Idempotency suppresses duplicate side effects and cursor remains valid. |
| I-04 | P0 | A | Feed supervisor valid, malformed-then-valid, and permanently invalid decisions. | Retry/dead-letter behavior is logged; malformed text cannot create mutations; dry-run labels remain explicit. |
| I-05 | P0 | A | Issue and use worker reporter credential, then try wrong node/expired token. | Correct node reports succeed; wrong/expired use is rejected without append. |
| I-06 | P1 | A | Interrupt bridge during worker creation/state persistence and restart. | Lock/state recovery is deterministic; no two active owners or orphaned fabricated result. |
| I-07 | P1 | A | Send annotation and failure envelopes to supervisor. | Journal decisions refer to exact envelope range and are not mistaken for worker execution. |

### J. Responsive, accessibility, and interaction quality

| ID | Pri | Mode | Preconditions and actions | Expected result |
| --- | --- | --- | --- | --- |
| J-01 | P0 | A/M | Run core inspect/confirm journey at 390×844. | No page-level horizontal overflow; graph and panels remain reachable; primary confirmation controls are visible. |
| J-02 | P1 | A/M | Run at 1280×720 with long content and browser zoom 200%. | Essential actions remain reachable without overlapping fixed UI. |
| J-03 | P0 | A | Keyboard-only: skip through top controls, graph selection, tabs, forms, and dialogs. | Visible focus; logical order; Enter/Space operate controls; Escape closes cancellable dialogs. |
| J-04 | P0 | A | Open confirmation/structural dialogs, tab repeatedly, then close. | Focus enters and stays in modal, returns to trigger, and background does not operate. |
| J-05 | P1 | A/M | Enable reduced motion. | Realtime/selection meaning survives; nonessential animation is reduced and no content flashes. |
| J-06 | P1 | A/M | Inspect status colors and disabled/loading/error states. | Meaning is not color-only; accessible names and reasons are present; double-submit is prevented. |
| J-07 | P1 | A | Run an automated accessibility scan if available without new dependency; otherwise semantic assertions. | No serious/critical violations in landing workspace, inspector, and confirmation dialog. |

### K. Production deployment smoke

| ID | Pri | Mode | Preconditions and actions | Expected result |
| --- | --- | --- | --- | --- |
| K-01 | P0 | A | Deploy tested worktree; request `/`, `/compat`, `/tools`, assets, and API health. | 2xx responses, SPA routes resolve directly, assets are immutable/cacheable as configured, health is truthful. |
| K-02 | P0 | A/N | Open production `/compat` in native WebMCP browser and run self-test/hello. | Detection, registration, discovery, and execution pass on deployed bytes. |
| K-03 | P0 | A/M | Fresh production clone: inspect graph, select node, open inspector/timeline, reload. | App is usable with no console/network errors; identity and state persist. |
| K-04 | P0 | A/N | On fresh production clone execute one safe read tool and one confirmed isolated mutation. | Result/state/cursor agree; confirmation is visible; seed and unrelated projects are unchanged. |
| K-05 | P0 | A | Verify deployed alias/build identity against local tested source. | Production alias points to the final deployment; no later untested source is presented as verified. |
| K-06 | P1 | A/M | Repeat production workspace smoke at 390×844. | No regression unique to production headers/assets/viewport. |

## 5. Automation mapping and execution order

The run proceeds in this order so later evidence is not built on a broken lower layer:

1. **Static baseline:** app/server/bridge unit and integration tests; app/server/bridge builds; app lint.
2. **Server contract probes:** identity, authorization, confirmation, stale cursor, idempotency, reporter boundary, WS/SSE.
3. **Bridge integration:** confirmed dispatch through supervisor and worker state, including restart/idempotency cases covered by existing suites.
4. **Local browser smoke:** fresh bootstrap, selection/inspector/timeline, reload, confirmation denial and success, console/network audit.
5. **Local adversarial browser:** mobile, long text, concurrent tabs, stale preview, transport loss/recovery.
6. **Native WebMCP:** compatibility page, discovery, representative read/mutation/contextual tools, lifecycle cleanup.
7. **Regression pass:** rerun all changed-package tests plus full baseline and inspect the complete diff.
8. **Production:** deploy once after all fixes, execute K-01 through K-06, and record exact deployment evidence.

Existing Vitest suites are authoritative for event folding, schemas, tool handlers, capability primitives, and bridge modules. Browser E2E must still cover the composed experience; a passing unit suite cannot substitute for rendered UI, native registry, transport, or confirmation checks.

## 6. Defect handling

For every failure:

1. Save the exact command, browser state, project/cursor, screenshot, console, and failed request.
2. Reduce to the smallest reproducible case and determine whether it predates the current change.
3. Fix the production source unless the test itself violates the frozen contract.
4. Add the narrowest regression test that fails before and passes after the fix.
5. Rerun the failing case, its package suite, and any cross-package journey it affects.
6. Record unresolved adjacent issues without expanding scope silently.

Tests are never weakened, skipped, or relabeled as passing to reach release. A native-browser case that cannot be exercised is reported as unverified, not inferred from mocks.

## 7. Run record

The final run evidence and deviations are recorded in `PROGRESS.md`. Generated screenshots/traces remain under `output/playwright/` and are not committed unless explicitly required for submission evidence.
