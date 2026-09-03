# Devpost submission draft (fill-in for the human submitter)

**Project name**: MissionGraph
**Tagline**: A web page where people and agents who work at different times meet: state, authority and the record live on the page. Your agent comes in through WebMCP in ChatGPT. A real Codex fleet does the work.

## Inspiration

People and agents rarely work at the same time. Agents run while you are away, you drop in when you can, and today's WebMCP is pull-only — a page cannot wake an agent. So the collaboration needs a place that is always there: the web page itself, holding the shared state, the authority to act, and the record of what happened. MissionGraph is that page, built for long, intermittent missions: the browser agent is caught up on every return, humans grant a policy once instead of approving every step, the page mirrors human context back to the agent as tools, and everything consequential is on the ledger. Our first tenant is the hardest one we know — a fleet of real Codex workers building software — but the substrate is not code-specific.

## What it does

MissionGraph is a live task-DAG canvas shared by three kinds of minds:

- **You** drag, annotate, dispatch, and approve on the canvas.
- **Your browser agent** (ChatGPT via WebMCP) plans missions onto the graph, narrates everything you missed, clears approval queues under policies you state in one sentence and visibly confirm (the agent cannot self-authorize — one confirmation mints a nonce-bound, multi-use grant, and every approval records the policy it cited), finds idle work, and re-engineers the graph mid-flight — through a 25-tool always-on core plus 5 contextual tools keyed to selection and failure state. Dynamic-capable runtimes register only the applicable contextual tools; the static fallback keeps all 5 registered and returns not-applicable results when their state does not match.
- **A real Codex worker fleet** executes tasks in isolated git worktrees, reporting lifecycle, logs, and structured handoffs through node-bound short-lived credentials, coordinated by a Codex supervisor whose every scheduling decision is a recorded, auditable turn. The bounded public judge fleet admits human-confirmed dispatches first-in-first-out.

Three scenarios: S1 Genesis (co-planning a paragraph into a DAG), S2 Flight (co-supervision of live workers), S3 Rewire (recording a mid-flight split after previewing its stale/pausing-work blast radius, re-routing edges, and recomputing the critical path). A running worker keeps its original brief until it exits; the supervisor can then re-brief the idle thread.

## Why WebMCP (the challenge question)

The intelligence already sits in the visitor's browser — their own agent, with their context and their authority. WebMCP gives that agent hands on shared, live project state that DOM manipulation could never reach (a canvas DAG behind an event ledger), and gives the page a way to mirror human context back (selection → dynamically registered tools via `toolchange`). Human + browser agent + worker fleet each do what only they can: judgment, narration + policy execution, throughput.

The page and the server run no model. The visitor's agent comes in through WebMCP with its own model and its own authority. The fleet that does the work runs on the mission owner's Codex, wherever the bridge daemon runs. The public site hosts one fleet so judges can watch a real worker; it is capped at twenty dispatches a day, and its API key exists only on that server.

What people and agents can do together that was difficult or impossible before: **supervision-by-exception of a parallel agent fleet through one shared living graph** — with a complete audit trail.

## How we built it

Event-sourced core (Node 22 / Fastify / SQLite append-only ledger, fold reducer, actor-labeled events), React Flow + elkjs canvas folded from the same ledger over WS/SSE, WebMCP tool surface with live-probed tier detection and an indefinite runtime waiter (AbortController tier verified in ChatGPT's built-in browser and flagged Chrome; `provideContext` replacement fallback; the page keeps polling so tools appear even when site tools are enabled minutes after load), and a bridge daemon that pumps structural events to a Codex supervisor session (`codex exec resume`, one in-flight turn, session memory) and mechanically executes its JSON decisions — spawn/pause/resume/rebrief/kill workers in git worktrees and record journal notes.

A human-presence capability layer separates agent proposals from human authorization: consequential actions stage a visible confirmation dialog (exact text, SHA-256 binding, expiry, use budget); one confirmation mints a nonce-bound grant, and the audit ledger records the capability reference and use nonce on every consequential event.

Every tool result carries `cursor` + `changes_since` (the digest pattern), so an agent that was away is fully caught up by its next call.

The package suites pass 323 tests (server 87 / bridge 109 / app 127); the fleet stub passes 19 acceptance scenarios.

## Challenges / what we're proud of

- **Adversarial review loops**: every milestone was reviewed by an independent adversarial session; 70+ P1/P2 findings were found and fixed (credential scoping, node-bound reporting, at-least-once delivery with a durable action ledger, identity-epoch fencing, an eight-finding security audit driven to human-presence grants with nonce-bound uses). The PROGRESS.md log keeps the whole trail, including our own false alarms.
- **We found our own worst bug by attacking ourselves**: a four-reviewer audit of the judge-fleet work turned up a prompt-injection chain in code that had already shipped — identifiers were validated only for non-emptiness, the browser agent's own `temp_id` became the durable node ID, and the worker prompt interpolated that ID one line above the task brief. A newline in a task ID was therefore an instruction to a real Codex worker, while the human's confirmation dialog showed only the innocent title. It is closed in three layers: a strict identifier grammar at the event boundary, JSON-encoded prompt fields so no value can start a line, and client-generated node IDs. One reviewer's mutation testing also proved which of our guarantees had no test behind them at all — flipping the fleet default from off to on left every suite green — so those tests exist now.
- **The real runtime beat our mocks twice**: three mock-green review rounds missed a CLI flag regression that the first real supervisor turn caught; later, the real ChatGPT browser rejected our pre-aborted tier probe with an opaque object no mock predicted — the fix (a live-signal probe) was verified in the real browser the same day. Live functional arbitration is part of the loop for exactly this reason.
- **Real history only**: the seed every judge clones is an export of a real run — actual Codex workers, actual handoffs and approvals, with each worker's commit IDs recorded in its handoff. The first real supervisor turn caught a bug three rounds of mock-green tests had missed; that arbitration run is in the seed.

## What's next

Timeline scrubbing (time travel over the ledger), multiplayer cameo, conflict-edge auto-detection.

WebMCP today is pull-only: a page cannot wake the agent — only tool results and toolchange-driven tool-list updates carry information from page to agent, seen on its next turn. MissionGraph is engineered for exactly that reality (every tool result carries a cursor plus `changes_since`), and for the day it changes: if WebMCP maps MCP's resources-and-subscriptions model into the browser, the mission ledger is already the subscribable event stream — the graph becomes a pager for the visitor's agent with little architectural change. And the substrate is not code-specific: the task DAG, lifecycle, human-presence grants, handoffs, and audit trail apply to any long-running mission — research pipelines, ops runbooks, content production; a Codex fleet is simply today's most demanding tenant.

---

### Submission fields checklist (§10)

- [ ] **Live URL**: https://missiongraph.vercel.app (VM + frontend must stay up through Sep 21)
- [ ] **Video**: YouTube, public, <3:00, audio narration (see docs/VIDEO_SCRIPT.md)
- [ ] **Repo**: made public at submission time, MIT license visible
- [ ] **Testing note for judges**: works in ChatGPT's built-in browser natively — latest app, model GPT-5.6 Sol or Terra (Luna has WebMCP disabled), Settings → Browser → Permissions → "Enable site tools" ON, non-Enterprise workspace. In Chrome 149+ enable `chrome://flags/#enable-webmcp-testing`. First visit auto-clones a private copy of a real mission — three suggestion chips show what to ask your agent first: "Ask your agent to catch you up on this mission", "Ask it to clear the approval queue under a policy you state", and "Split the rate-limit task into config and enforcement halves — show me the blast radius first." The clone includes a real pending approval to clear under your policy, an idle-ready task, and a splittable in-flight graph. Dispatching a task borrows a small shared live Codex fleet: up to twenty accepted requests per UTC day, one per project, one worker at a time; when capacity is unavailable the page says so, and live worker execution is also demonstrated in the video. Only unchanged seeded tasks run on the live fleet; tasks you create or edit are dispatched in supervision-only mode, and both the page and the agent say which is which.
