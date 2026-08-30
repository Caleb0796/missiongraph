# MissionGraph — Goal Plan

**WebMCP Challenge entry** (webmcp.devpost.com) · Deadline: **Sep 3, 2026, 13:00 PDT**
Working name: `MissionGraph` (rename allowed, see §12). Plan version: 2026-08-30.

---

## 0. How to execute this plan (for Codex or any coding agent)

- Work **milestone by milestone** (§8). Each milestone has a Definition of Done. Do not start M(n+1) before M(n)'s DoD passes.
- Decisions marked **[HUMAN]** are reserved for the human. Stop and ask when you hit one that is still unresolved.
- The constraints in §7 are non-negotiable. If a constraint conflicts with a feature, the feature loses.
- Every feature you build must trace back to a pain point ID (§2) and appear in a scenario (§3). If it doesn't, don't build it.
- Acceptance criteria are written as **observable demo beats** — "a judge can see X happen on screen". If your implementation passes tests but doesn't produce the visible beat, it is not done.

## 1. Mission

MissionGraph is **mission control for graph-parallel agent engineering**. A project is a live dependency graph (DAG) of tasks. Codex worker sessions execute the nodes; a Codex supervisor session auto-manages by policy; the human and the human's own browser agent (ChatGPT, via WebMCP) plan, supervise, and re-engineer the graph together on one shared canvas.

Contrast that motivates the product: **loop engineering** (one agent, one thread, one todo list) is legible but slow — you watch one line move. **Graph engineering** (many agents in parallel) is fast but today it is a black box: no tools to author the graph, no visibility into progress, no visibility into how the graph changes, no way for a human to intervene surgically. MissionGraph exists to make the parallel form as legible as the linear form.

Judged criteria mapping (each 25%):
- **WebMCP Leverage** → §4 tool surface (24 core tools + dynamic contextual registration) is the product's primary interface.
- **Execution** → §6 UX spec + §8 DoD gates; seeded "living project" so judges enter mid-movie.
- **Potential Impact** → §2 pain inventory; audience = every team running parallel coding agents (Codex fleets, Claude Code workflows).
- **Creativity & Ambition** → human + browser-agent + backend-agent-fleet triad; agent-driven camera; approval queue ranked by critical-path impact.

## 2. Pain inventory (the design's backbone)

Phase G = genesis (planning), F = flight (execution), R = rewire (re-planning).

| ID | Phase | Pain (vs linear loop engineering) |
|----|-------|-----------------------------------|
| P1 | G | Plans live in chat text; no structural editor; dependencies implicit in prose |
| P2 | G | Task granularity is wrong: too big (worker drowns) or too small (overhead swamps) |
| P3 | G | Dependencies mislabeled/missing — discovered later as runtime blocks |
| P4 | G | File-overlap conflicts invisible at plan time (two parallel tasks touching one module) |
| P5 | G | Critical path unknown at plan time, so priorities are guesses |
| P6 | F | Progress black box: N workers running, no single picture |
| P7 | F | Change blindness: "what happened while I was away?" requires log archaeology |
| P8 | F | Idle ready branches: tasks unblocked but unassigned, nobody notices |
| P9 | F | Critical-path stalls detected too late; whole project slips silently |
| P10 | F | Approval bottleneck: human reviews arrive as a flat FIFO queue; critical-path approvals don't jump the queue |
| P11 | F | Failure handling is manual archaeology: retry? reassign? escalate? |
| P12 | F | Merge conflicts from parallel branches surface at the end, not when the overlap begins |
| P13 | R | Reality diverges from plan (hidden complexity discovered mid-task); plan rots |
| P14 | R | Editing a running graph is scary: unclear what's safe to cut/split/merge, what downstream context it invalidates |
| P15 | R | New requirements have no obvious attachment point; inserting them invalidates unknown work |
| P16 | F | Completed work is opaque: what a worker actually did, changed, and handed off is buried in raw logs |
| P17 | F/R | No audit trail: who approved what under which policy, and where reality deviated from the plan |

## 3. The three scenarios (product spine = video spine)

### S1 · Genesis — human + agent co-author the graph (P1–P5)

**Narrative.** Human opens a blank project, tells their ChatGPT the goal in one paragraph. Agent calls `plan_seed` → a first-draft DAG blooms on the canvas (typed tasks, dependency edges, estimates). Human drags nodes, deletes one, says "these two will both touch the auth module" → agent calls `link`/`annotate` to add a conflict edge (P4). Agent calls `get_critical_path` and `highlight_path` → the spine of the project lights up (P5). Human asks "is anything too big?" → agent proposes `split_task` on two oversized nodes (P2).

**Beat (video/judge):** goal paragraph → living DAG with a glowing critical path, in under 60 seconds.

**Acceptance criteria:**
- Blank → seeded DAG via a single `plan_seed` tool call (agent supplies the decomposition; the tool validates + lays out).
- Human edits (drag/delete/connect) and agent edits (`add_task`/`link`/`split_task`) interleave without conflict; every mutation animates.
- Critical path recomputes live and is visually distinct at all times.

### S2 · Flight — co-supervision while Codex executes (P6–P12)

**Narrative.** The seeded live project is mid-run: some nodes green, two running with streaming status, one failed, four approvals pending (three clearable under the demo policy, one DB-schema exception). Human returns after time away, says "catch me up". Agent calls `graph_digest(since)` → narrates the diff while driving the camera (`focus`, `highlight_path`) — speech and view synchronized (P6, P7). Human: "clear the approval queue per my policy: auto-approve <50-line diffs with green tests, escalate anything touching the DB schema." Agent works the queue with `list_pending_approvals` (sorted by critical-path impact, P10) + `approve`/`reject`, hands ONE exception back to the human. Agent notices via digest that node "API docs" has been ready-but-unassigned for 40 min off the critical path (P8) → asks → `dispatch` → within seconds the node flips to running, and the human watches a real Codex worker pick it up (P11: a failed node gets `retry_with_guidance` with a one-line hint instead of log archaeology).

**Beat:** "catch me up" → 20-second narrated, camera-driven tour of everything that changed; then one sentence of policy clears three approvals and staffs an idle branch.

**Acceptance criteria:**
- `graph_digest` returns a structured change-feed since a cursor; every other tool's result also carries `changes_since` (digest pattern — the agent never needs push).
- Approval queue is ordered by critical-path impact, and the ordering is visible in the UI, not just the tool result.
- `dispatch` reaches a real Codex worker end-to-end; node state transitions (queued→running→review→done) stream back over WS and animate live.
- Clicking a node = selection that the agent can read via `get_selection`; selection also dynamically registers contextual tools (`dispatch_selected`, `explain_selected`, `split_selected`) via `toolchange`.
- Selecting (single click) any node or edge opens its **dossier** in the inspector (P16/P17): human-readable brief, handoff record, deviations, decision trail — prose first, never bare IDs.

### S3 · Rewire — re-engineering the graph mid-flight (P13–P15)

**Narrative.** A running worker reports hidden complexity: "task 'payments' is actually 3 tasks." Agent proposes `split_task` on a RUNNING node → the UI shows a **blast-radius preview**: which downstream nodes' context becomes stale, which workers pause (P14). Human drags one new subtask to depend on a different node, approves the rewire. Workers are re-briefed automatically (supervisor session receives the diff). A new requirement arrives mid-flight: human says "we also need rate limiting" → agent `add_task` + proposes attachment edges, shows what it invalidates (P15) → human approves.

**Beat:** the plan visibly bends without breaking: a running node splits in place, blast radius flashes, workers re-brief, the critical path re-routes on screen.

**Acceptance criteria:**
- Structural edits on non-idle nodes require `confirm: true` and show a blast-radius preview (affected downstream set) before applying.
- After a rewire, the Codex supervisor session receives a machine-readable graph diff; re-briefing is logged on the timeline.
- Critical path re-computation after rewire is animated (old path fades, new path lights).

## 4. WebMCP tool surface (the scored API)

Registration: `document.modelContext` with `navigator.modelContext` fallback (§5 snippet). Every tool's `execute` returns a JSON **string** (Chrome's imperative API contract: tools return strings — no MCP content-array wrapper), and every result JSON includes `cursor` + `changes_since` (digest pattern). Tags: **[M2]** = core build, **[M4]** = flight polish, **[M5]** = scenario polish. Signatures below are shorthand — the JSON schemas in code are the contract (§13).

**Graph verbs (S1/S3)**
1. `plan_seed(goal, tasks[])` [M2] — batch-create initial DAG from agent's decomposition; validates cycles, auto-layout.
2. `add_task({title, brief, deps, estimate, tags})` [M2]
3. `link(upstream, downstream, kind: depends|conflicts)` / `unlink(edge_id)` [M2] — `depends`: upstream must complete before downstream may start; arrows render upstream→downstream. `conflicts`: undirected advisory edge (P4/P12), excluded from cycles/critical path.
4. `split_task(id, subtasks[], confirm?)` [M5] — blast-radius preview when node not idle.
5. `merge_tasks(ids[], confirm?)` [stretch] — cut from MVP per the §13 YAGNI rule; no scenario beat uses it.
6. `annotate(target_id, note)` [M2] — nodes AND edges; an edge annotation carries the dependency's rationale (why this edge exists — the least-documented fact in any plan).
6b. `remove(node_id, confirm?)` [M2] — tombstone delete for NODES only (edges are deleted via `unlink`); requires preview+confirm when the target is non-idle or depended-on (§13 mutation safety).

**Supervision verbs (S2)**
7. `graph_digest(since?)` [M2] — full state summary + ordered change feed. The workhorse.
8. `list_ready()` [M2] — unblocked & unassigned (idle-branch radar, P8), with time-idle (clock starts at the reducer-derived ready transition) and critical-path distance (estimated-duration slack vs the current critical path).
9. `list_pending_approvals()` [M2] — sorted by critical-path impact (P10).
10. `approve(id, policy_ref?, rationale?)` / 11. `reject(id, reason, policy_ref?)` [M2] — human-actor calls need no `policy_ref`; agent-actor calls REQUIRE one and are rejected without it; policy text + ref are logged on the timeline (§5 security).
11b. `state_policy(text)` [M4] — mints the `policy_ref`: records the human's verbatim approval policy (relayed by the agent or entered in UI), scoped to the current browser session; returns the ref used by subsequent agent-actor `approve`/`reject` calls.
12. `dispatch(id, brief_override?)` [M3] — enqueue to Codex supervisor.
13. `retry_with_guidance(id, guidance)` [M4]
14. `set_node_run_state(id, pause|resume)` [M5]
15. `get_node(id)` [M2] — accepts node OR edge ids; returns the full dossier: brief, status, handoff record, deviations, decision trail, worker log tail, artifact links.
16. `get_critical_path()` [M2]
17. `get_selection()` [M2] — what the human currently has selected (shared context channel).

**Lens verbs (agent-driven camera — visualization AS conversation)**
18. `focus(ids[])` [M2] — pan/zoom to nodes.
19. `highlight_path(mode: critical | between(from,to))` [M2]
20. `explain_overlay(id, text, ttl)` [M5] — anchored callout the agent places while narrating.

**Audit & journal verbs (P16/P17)**
21. `journal_note(text)` [M5] — project-level record for non-node-scoped matters (policies stated, global decisions, rewires) — the "other ledger".
22. `get_journal(since?)` [M5] — project journal + decision trail. Audit **reports** are the agent's job, generated on demand from this data — the site only serves the ledger.

**Contextual dynamic tools (registered/unregistered live → `toolchange`)**
- On selection: `dispatch_selected`, `explain_selected`, `split_selected` [M5].
- While ≥1 node failed: `review_failures()` [M5].
- Rationale: the tool list itself mirrors shared state — the page's only spec-native push channel to the agent.

## 5. Architecture

**Channels (fixed, from design discussion):**

| Channel | Mechanism | Notes |
|---|---|---|
| Human ⇄ canvas | native UI | never force the human through an agent; every tool action has a UI equivalent |
| ChatGPT ⇄ page | WebMCP tools (pull) + `toolchange` | page CANNOT wake the agent; digest pattern compensates |
| Page ⇄ server | WebSocket (SSE fallback) | full-duplex, drives live node animation |
| Server ⇄ Codex | `codex queue` to a long-lived **supervisor session**; workers as subagents/worktrees | supervisor = autopilot when human absent |

**Components:**
- **Frontend:** React + Vite + TypeScript + **React Flow** (custom nodes: status chip, approval badge, progress ring) + Tailwind + elkjs (layered DAG layout). State: zustand, event-sourced from server log.
- **WebMCP layer:** one module `src/webmcp/` — registry wrapper, digest cursor plumbing, dynamic contextual registration. Feature-detect:

```js
const mc = document.modelContext ?? navigator.modelContext;
if (!mc) { showEnableBanner(); } // chrome://flags/#enable-webmcp-testing or open in ChatGPT browser
mc?.registerTool({
  name: "graph_digest",
  description: "Project state summary plus ordered change feed since a cursor.",
  inputSchema: { type: "object", properties: { since: { type: "string" } } },
  annotations: { readOnlyHint: true },
  async execute({ since }, { signal }) {
    return JSON.stringify(digest(since)); // tools return STRINGS per the imperative API
  }
});
```
  ⚠️ API is mid-migration (navigator→document, Chrome 149–156 origin trial). **M0 includes a compat spike** against the live ChatGPT browser + Chrome flag before anything else is built on top.
- **Server:** Node 22 + Fastify + `ws` + SQLite. **Event-sourced:** one append-only `events` table is the single source of truth; graph state = fold(events); every event carries `actor: human | browser_agent | supervisor | worker:<id>`. This gives the timeline, digests, actor-attributed narration, and seeding for free. Audit-bearing event types: `HANDOFF_FILED` (worker's structured completion record: what was done, files/commits touched, notes for downstream, deviations from brief), `DEVIATION_NOTED`, `EDGE_RATIONALE`, `JOURNAL_NOTE`. A node's dossier is just `filter(events, node_id)` rendered human-first.
- **Codex bridge:** server host runs `codex` CLI. One supervisor session per project (spawn on first dispatch; keep-alive). Server→supervisor via `codex queue`; supervisor spawns workers (subagents / separate sessions in worktrees); worker status → a tiny reporter hook appends events via HTTP → WS fan-out. Graph diffs (S3) are queued to the supervisor as structured messages.
- **Event flow — how human graph operations reach Codex:** every mutation lands in the event log first (actor-tagged), then a **materiality filter** decides who hears about it:
  - *Structural/semantic* events (approve, reject, dispatch, edge add/remove, node remove, split/merge, pause/resume, human notes) → forwarded to the supervisor via `codex queue` as a **self-contained JSON envelope** — structured fields + one English summary line so the supervisor never has to re-read the whole graph:
    `{"seq":142,"type":"EDGE_ADDED","actor":"human","upstream":"audit-log","downstream":"payments","summary":"Human added dependency audit-log→payments; payments is now blocked until audit-log completes."}`
  - *Cosmetic* events (drag position, zoom, selection) → logged for digests, never queued. Workers don't care where a node sits on screen.
  The supervisor processes envelopes on its next turn (seconds-scale latency — acceptable; workers operate on a minutes timescale) and re-briefs affected workers; its reactions come back as events through the reporter hook, closing the loop in the same log. The browser agent (ChatGPT) is never pushed to: human ops reach it via `changes_since` on its next tool call, actor-tagged, so it can narrate "you added an edge; the supervisor paused that worker at a safe point."
- **Deploy:** frontend on **Vercel** (sponsor credits); server + codex bridge on a **Render VM** (both resolved 2026-08-30, human may override). Note: serverless (CF Workers) cannot host codex CLI — the bridge needs a real VM.
- **Seeding:** `pnpm seed:export` / `seed:import` snapshot the event log. The judge-facing project's history MUST come from real runs recorded during development (constraint C5). Every judge/visitor gets an ISOLATED project instance cloned from the seed (with a reset control) — nobody shares mutable state.

**Security / guardrails:**
- Tools are least-privilege; anything destructive or affecting running workers requires `confirm:true` + UI confirmation with undo window.
- `approve`/`reject` by the agent are valid only under a human-stated in-session policy; every such call logs the policy text and is visually marked "agent-approved under your policy" on the timeline.
- Treat all tool inputs as untrusted; worker log excerpts rendered as text only (prompt-injection surface); never expose secrets in tool results.
- Public demo: dispatch rate-limited per visitor; worker tasks capped in size; judge credentials in submission notes if needed.

## 6. UX spec

- **Layout:** full-bleed canvas. Top bar = project pulse (critical-path ETA, running/blocked/failed counts, live dot). Right inspector = the **dossier** of the selected node or edge (single click = select AND open dossier — one gesture, no separate "open" action), tabs: Brief (what/why, human language) · Handoff (what was delivered: files, commits, notes to downstream) · Deviations (estimate vs actual, scope drift) · Decisions (who approved what, under which policy) · Log (worker tail). Approve/Reject/Dispatch buttons live here. **Readability rule:** every record must be re-readable by a human three days later — prose first, bare IDs forbidden. Bottom = timeline strip of events (click = jump camera; project-journal entries interleaved).
- **Node anatomy:** status color (queued gray / ready blue / running animated ring / review amber / done green / failed red / blocked striped), critical-path nodes get thick warm edges, approval badge, idle-timer chip on ready-unassigned nodes (P8 radar).
- **Catch-up mode:** on return (or judge first load), a "since you left" chip; clicking the chip replays the diff as a quick highlight sequence (list + camera moves, not a full scrubber — scrubber = stretch). The agent's path is different: `graph_digest` is read-only (§13); the agent narrates and drives the camera itself via lens verbs.
- **Agent presence:** every agent-driven mutation/camera move shows a small "🤖 via your agent" toast; human actions show none. Judges must be able to tell who did what.
- **Judge first-run:** seeded mid-movie project + three suggestion chips: "Ask your agent to catch you up" / "…to clear approvals under a policy you state" / "…to find idle work and staff it". Enable-flag banner when WebMCP is absent.
- **No embedded chat.** The conversation lives in the browser's agent UI; our page is the shared workbench. (One canvas, no separate dashboard pages.)

## 7. Hard constraints (non-negotiable)

- **C1** WebMCP tool surface is the product's primary interface; every capability reachable via tools; UI parity for humans.
- **C2** Judges enter mid-movie: seeded living project + pending approvals + one dispatchable real task that completes in tens of seconds with live streamed status (it runs inside the already-warm supervisor session — no cold worker spawn).
- **C3** Demo video = real screen capture; timelapse allowed and labeled; zero slideshow-only segments.
- **C4** No task-engine of our own: orchestration = Codex primitives (`codex queue`, subagents, supervisor session).
- **C5** No fabricated execution: seeded history is exported from real runs; live dispatch runs real workers.
- **C6** Feature-detect `document.modelContext` AND `navigator.modelContext`; verified in both ChatGPT in-app browser and Chrome 149+ flag.
- **C7** Open source under MIT (resolved 2026-08-30), public repo, license visible in the About section.

## 8. Milestones

| M | Scope | Definition of Done |
|---|-------|--------------------|
| **M0** | Scaffold + compat spike (½ day) | Vite app deployed; hello-world WebMCP tool callable from ChatGPT browser AND flagged Chrome; WS echo server up on VM. **Hard gate: if the compat spike fails in the ChatGPT browser, STOP and report [HUMAN].** |
| **M1** | Graph core (¾ day) | Event-sourced store; React Flow canvas renders seeded JSON DAG; statuses, critical-path computation + styling; drag/connect/delete by hand. |
| **M2** | Tool layer (¾ day) | All [M2] tools live; digest cursor works; `get_selection`; lens verbs move the camera; agent can build a graph from scratch conversationally (**S1-core pass**: seed/edit/critical path — the split beat lands in M5). |
| **M3** | Codex bridge (¾ day) | `dispatch` → supervisor session → worker runs a real tiny task → events stream back → node animates through its lifecycle. Worker brief template REQUIRES filing a structured handoff on completion (`HANDOFF_FILED`), rendered in the node dossier. One-command server setup documented. |
| **M4** | Flight polish (½ day) | Approval queue w/ critical-path ordering; policy-based agent approvals (`policy_ref`) + timeline marking; idle radar; `retry_with_guidance`; **S2-core pass** end-to-end (contextual tools land in M5). |
| **M5** | Rewire + contextual tools (½ day) | split with blast-radius preview + confirm; graph-diff re-brief to supervisor; dynamic contextual tools on selection/failure; **S1/S2/S3 pass in full**. |
| **M6** | Seed + submission (½ day) | Real-run seed exported/imported; suggestion chips; README + MIT license; write-up draft (uses §10 skeleton); video shot per §9; deployed URLs stable; submission fields filled. |

Stretch (only after M6): timeline scrubber (time travel), second-human multiplayer cameo, `conflicts`-edge auto-detection from file manifests.

## 9. Video storyboard (<3:00, voiceover, real capture)

- 0:00–0:20 — Problem: split screen, linear loop (one crawling todo list) vs a stalled black-box parallel run. "Parallel agents are fast — and illegible."
- 0:20–1:00 — S1 Genesis: paragraph → blooming DAG → critical path ignites. Human drags; agent splits an oversized node.
- 1:00–2:00 — S2 Flight (timelapse labeled): workers running; "catch me up" camera tour; one-sentence policy clears the approval queue; idle branch staffed; a real node goes green in 10s.
- 2:00–2:40 — S3 Rewire: running node splits, blast radius flashes, workers re-brief, critical path re-routes.
- 2:40–3:00 — Close: "Your agent supervises the fleet. You supervise by exception. The web page is the shared mission control." + repo/URL card.

## 10. Submission checklist

- [ ] Live URL (frontend + VM alive through Sep 21 judging end), tested in ChatGPT in-app browser and Chrome 149+ w/ flag
- [ ] YouTube video <3:00, public, audio narration
- [ ] Public repo, MIT license visible in About
- [ ] Write-up: why WebMCP — skeleton: *"The intelligence already sits in the visitor's browser — their own agent, with their context and their authority. WebMCP gives that agent hands on shared, live project state that DOM manipulation could never reach (a canvas DAG), and gives the page a way to mirror human context back (selection→dynamic tools). Human + browser agent + worker fleet each do what only they can: judgment, narration+policy execution, throughput."*
- [ ] What-humans-and-agents-do-together-that-was-impossible: supervision-by-exception of a parallel agent fleet through one shared living graph
- [ ] Timestamped commit history (project is new — entire history in-window)

## 11. Risks

| Risk | Mitigation |
|---|---|
| WebMCP API drift / ChatGPT browser quirks | M0 compat gate before anything else; wrapper isolates API shape |
| Codex bridge flaky on VM | M3 gate; keep worker tasks tiny; supervisor keep-alive + restart script; seeded project keeps demo alive even if live dispatch degrades |
| Graph UI reads as toy | §6 polish items are DoD, not nice-to-have; elkjs layout; motion design on state changes |
| Judge session has no OpenAI-side agent quirks we didn't test | Test the exact judge path (fresh profile, chips) daily from M4 on |
| Scope creep | Every feature must cite a pain ID; stretch list is post-M6 only |

## 12. Decisions log (all resolved 2026-08-30; the human may override any default)

1. **Server host — RESOLVED (default accepted):** Render VM.
2. **Seeded demo project — RESOLVED (default accepted):** URL-shortener microservice w/ tests+docs (~15 nodes).
3. **Product name — RESOLVED:** `MissionGraph`, confirmed by the human.
4. **License — RESOLVED (default accepted):** MIT.
5. **Eligibility — RESOLVED:** entrant is a US resident; eligible under the official rules.
6. **Frontend host — RESOLVED (default accepted):** Vercel.

## 13. Executor clarifications (ratified 2026-08-30)

Ratified answers to an executor comprehension review (Codex `gpt-5.6-sol`, ultra effort). These are DECISIONS, not suggestions. Where §4 shorthand conflicts with this section or with the JSON schemas in code, this section and the code win.

**API & tools**
- The §5 WebMCP snippet is illustrative; the live API observed during M0 is authoritative behind the wrapper. Guard against a missing `mc` before any registration. Per Chrome's imperative API docs (verified 2026-08-30): tool `execute(inputs, {signal})` returns a plain JSON STRING; dynamic unregistration = `registerTool(tool, {signal: abortController.signal})` + `abort()`, **Chrome 153+ — currently BETA; 152 is stable and judges will be on stable, so 152 compatibility is a HARD requirement.** The wrapper feature-detects abort-unregistration: on ≥153 use it; on ≤152 fall back to full-set replacement via `provideContext({tools})` (M0 verifies replace semantics + `toolchange` firing on 152); last-resort fallback = contextual tools stay registered and return "not applicable to current selection". Shipped behavior must be IDENTICAL on 152 and 153 (mechanism is internal). Chrome Beta side-by-side install is optional, for verifying the enhanced path only. Put `annotations: {readOnlyHint: true}` on all read tools; self-test registration in-page via `getTools()`/`executeTool()` BEFORE any agent testing; page needs origin isolation and the `tools` Permissions Policy (defaults to self). Details pinned in docs/webmcp-notes.md.
- Tool JSON schemas in code are the contract; §4 signatures are shorthand (tagged unions for `highlight_path`, enums for `set_node_run_state`).
- M0 hello tool: `hello_missiongraph` → `{ok:true, ts, env, cursor, changes_since:[]}` — envelope-compliant from day one; proof = discovered, invoked, valid content returned, in BOTH target browsers.
- Edge identity: `link` results and digests expose stable `edge_id`s; `get_node(id)` accepts node AND edge ids.
- Contextual tools are thin aliases over core ops bound to the current selection; only actions valid for the selected element register (edge selection: explain only).
- `review_failures()` summarizes + focuses failed nodes; never mutates.
- `plan_seed` tasks reuse `add_task` fields + batch-local temp ids; validated atomically; server assigns persistent ids.

**Cursor / digest**
- Cursor = event sequence number as an opaque string, maintained automatically per browser client session by the WebMCP wrapper; `graph_digest(since)` allows explicit override. Cursor state is per client, never project-global.
- `changes_since` returns events strictly after the cursor, INCLUDING events caused by the current call. Error and preview results carry the same envelope.
- `graph_digest` is read-only — it never moves the camera. Camera motion is exclusively lens verbs. Digest = graph/status/approval/critical-path summary + bounded change feed; full logs stay behind `get_node`.
- `toolchange` updates tool discovery only; it can never initiate an agent turn.

**Graph semantics**
- `depends` edges: `link(upstream, downstream)` — upstream completes before downstream starts; arrows render upstream→downstream. `conflicts` edges: undirected advisory; excluded from cycle validation and critical path; alert the supervisor; never auto-block. Auto-detection from file manifests stays stretch.
- Every dependency mutation revalidates the DAG atomically; cycles rejected pre-append.
- Node states: ready/blocked are reducer-derived; lifecycle transitions (queued→running→review→done, failed, paused) are explicit and validated.
- "Idle" = queued/ready with no execution history; anything ever started is non-idle.
- Estimates are minutes; actuals replace estimates once known. Critical path = longest remaining path by estimate over `depends` edges only; empty graph shows none; deterministic tie-breaking.
- Approval ranking: projected delay impact, then age. Approval facts (diff size, test status, files touched) come from worker handoff structured fields.
- Review/approval model: a worker handoff moves its node to `review` and creates exactly ONE approval record; approve → done; reject(reason) → back to running with the reason as guidance.

**Mutation safety**
- Two-step confirm protocol for any structural mutation touching non-idle nodes (`split_task`, `merge_tasks`, `remove`, `unlink`, `link` into a running graph): the call WITHOUT `confirm` returns a non-mutating blast-radius preview + `op_token`; the call WITH `confirm:true` + `op_token` applies exactly that preview. S3 rewires batch into one pending proposal, applied atomically on approval.
- Undo: 10-second window via compensating events; disabled once a worker/supervisor acknowledgement lands.
- Splitting a running node: cooperative pause first; the original becomes a parent/group record holding the partial handoff; prerequisites re-attach to entry children, dependents to terminal children; the preview lets the human adjust mappings.
- Pause is cooperative: a queued request; UI shows "pausing…" until the worker acks.
- Blast radius = all transitive downstream nodes; only already-briefed ones are marked context-stale; only currently running affected workers pause.

**Server & events**
- Event columns: seq, project, type, actor, node/edge refs, timestamp, versioned JSON payload, idempotency key. Reducer is versioned + deterministic; invalid transitions rejected before append.
- Concurrency: server-authoritative sequencing; a stale mutation gets 409 + fresh digest, never a silent overwrite. Human/agent "interleave without conflict" means THIS, not CRDTs.
- Cosmetic events are debounced to settled values. Selection is per client session, actor-tagged.
- Actor attribution by channel: WS/UI mutations = `human`; WebMCP execute paths = `browser_agent`; reporter-token calls = `supervisor`/`worker:<id>`.
- Transport: sequenced JSON over WSS with resume-from-seq; SSE fallback is read-only (mutations via HTTP). HTTPS/WSS; per-visitor project token; separate short-lived reporter token.
- C4 boundary: the server computes projections (readiness, critical path, rankings) and relays explicit decisions; it NEVER chooses what to run next — that is the supervisor session's job.
- Supervisor autopilot defaults (encoded in its brief at M3): auto-retry a failed node once with 30s backoff; auto-dispatch CRITICAL-PATH ready nodes only, up to a concurrency cap of 2 (off-path nodes wait for human/agent — that gap IS the S2 idle-branch story); an explicit human/agent `dispatch` bypasses the cap (+1 slot); NEVER approve anything without a human `policy_ref`. The S2 seed records the failed node's auto-retry as already exhausted, so the retry beat belongs to the human+agent.
- Policy lifecycle: a policy is minted server-side when the human states it (UI or via agent relay), gets a `policy_ref`, and expires with the browser session; never inferred from old journal history.

**Demo & judging**
- The quick real task is a predefined docs/test micro-task in the seed repo, fresh per visitor copy; it executes INSIDE the already-warm supervisor session (no cold worker spawn), target under ~30s with live streamed status.
- Visitor clones freeze any `running` node to `paused (worker detached)` with its log tail preserved — history stays real, liveness comes only from actual dispatch. The demo video records OUR live instance (genuinely running workers); judges interact with per-visitor clones.
- Worker topology (ratified): separate `codex exec` sessions in git worktrees; subagents only if the M3 CLI probe shows they can carry the reporter lifecycle. M3 OPENS with an empirical probe of the live `codex queue` / session-launch surface — never guessed from docs.
- External accounts (Vercel, Render, GitHub, YouTube, submission) are human-supplied; the agent prepares everything to an authenticated-deploy-ready state and stops there.
- Workers commit in isolated worktrees and report commit ids in handoffs; NO auto-merge — merging is out of demo scope.
- Seed export = versioned, sanitized event stream (relative timing + provenance preserved; ids remapped on import).
- C1 parity means no capability is agent-only; it does NOT require a dedicated button per tool (digest ≈ catch-up chip; lens ≈ manual pan/zoom; journal ≈ timeline strip).
- Any tool not exercised by a scenario beat by end of M5 is cut (YAGNI). `merge_tasks` is already cut to [stretch]; next candidate: `set_node_run_state` if S3's pause beat ends up implicit.
- Scenario acceptance mapping: M2 = S1-core; M4 = S2-core; M5 = S1/S2/S3 in full. Feature-traceability lives in this file + PR descriptions; mandatory infrastructure is exempt from the pain-ID rule.
- Docs: `SETUP.md` (one-command server bring-up) lands at M3; README + submission text at M6. Verification = reducer/API tests + manual demo-beat checks in both target browsers; a passing test alone never satisfies a visual DoD.
