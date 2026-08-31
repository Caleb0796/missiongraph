# Devpost submission draft (fill-in for the human submitter)

**Project name**: MissionGraph
**Tagline**: Mission control for graph-parallel agent engineering — supervise a real Codex fleet by exception, through one shared living graph.

## Inspiration

Parallel agent fleets are fast — and illegible. Linear chat loops are legible — and slow. Running real multi-agent projects, we kept hitting the same wall: no shared picture of what's running, what's blocked, what changed while you were away, and no auditable trail of who decided what.

## What it does

MissionGraph is a live task-DAG canvas shared by three kinds of minds:

- **You** drag, annotate, dispatch, and approve on the canvas.
- **Your browser agent** (ChatGPT via WebMCP) plans missions onto the graph, narrates everything you missed, clears approval queues under policies you state in one sentence and visibly confirm (the agent cannot self-authorize — one confirmation mints a nonce-bound, multi-use grant, and every approval records the policy it cited), finds idle work, and re-engineers the graph mid-flight — through 26 WebMCP tools.
- **A real Codex worker fleet** executes tasks in isolated git worktrees, reporting lifecycle, logs, and structured handoffs through node-bound short-lived credentials, coordinated by a Codex supervisor whose every scheduling decision is a recorded, auditable turn.

Three scenarios: S1 Genesis (co-planning a paragraph into a DAG), S2 Flight (co-supervision of live workers), S3 Rewire (mid-flight re-engineering with blast-radius previews).

## Why WebMCP (the challenge question)

The intelligence already sits in the visitor's browser — their own agent, with their context and their authority. WebMCP gives that agent hands on shared, live project state that DOM manipulation could never reach (a canvas DAG behind an event ledger), and gives the page a way to mirror human context back (selection → dynamically registered tools via `toolchange`). Human + browser agent + worker fleet each do what only they can: judgment, narration + policy execution, throughput.

What people and agents can do together that was difficult or impossible before: **supervision-by-exception of a parallel agent fleet through one shared living graph** — with a complete audit trail.

## How we built it

Event-sourced core (Node 22 / Fastify / SQLite append-only ledger, fold reducer, actor-labeled events), React Flow + elkjs canvas folded from the same ledger over WS/SSE, WebMCP tool surface with live-probed tier detection and an indefinite runtime waiter (AbortController tier verified in ChatGPT's built-in browser and flagged Chrome; `provideContext` replacement fallback; the page keeps polling so tools appear even when site tools are enabled minutes after load), and a bridge daemon that pumps structural events to a Codex supervisor session (`codex exec resume`, one in-flight turn, session memory) and mechanically executes its JSON decisions — spawn/pause/rebrief/kill workers in git worktrees.

A human-presence capability layer separates agent proposals from human authorization: consequential actions stage a visible confirmation dialog (exact text, SHA-256 binding, expiry, use budget); one confirmation mints a nonce-bound grant, and the audit ledger records the capability reference and use nonce on every consequential event.

Every tool result carries `cursor` + `changes_since` (the digest pattern), so an agent that was away is fully caught up by its next call.

## Challenges / what we're proud of

- **Adversarial review loops**: every milestone was reviewed by an independent adversarial session; 60+ P1/P2 findings were found and fixed (credential scoping, node-bound reporting, at-least-once delivery with a durable action ledger, identity-epoch fencing, an eight-finding security audit driven to human-presence grants with nonce-bound uses). The PROGRESS.md log keeps the whole trail, including our own false alarms.
- **The real runtime beat our mocks twice**: three mock-green review rounds missed a CLI flag regression that the first real supervisor turn caught; later, the real ChatGPT browser rejected our pre-aborted tier probe with an opaque object no mock predicted — the fix (a live-signal probe) was verified in the real browser the same day. Live functional arbitration is part of the loop for exactly this reason.
- **Real history only**: the seed every judge clones is an export of a real run — actual Codex workers, actual commits, actual approvals. The first real supervisor turn caught a bug three rounds of mock-green tests had missed; that arbitration run is in the seed.

## What's next

Server-side FIFO with delivery leases, timeline scrubbing (time travel over the ledger), multiplayer cameo, conflict-edge auto-detection.

---

### Submission fields checklist (§10)

- [ ] **Live URL**: https://missiongraph.vercel.app (VM + frontend must stay up through Sep 21)
- [ ] **Video**: YouTube, public, <3:00, audio narration (see docs/VIDEO_SCRIPT.md)
- [ ] **Repo**: made public at submission time, MIT license visible
- [ ] **Testing note for judges**: works in ChatGPT's built-in browser natively — latest app, model GPT-5.6 Sol or Terra (Luna has WebMCP disabled), Settings → Browser → Permissions → "Enable site tools" ON, non-Enterprise workspace. In Chrome 149+ enable `chrome://flags/#enable-webmcp-testing`. First visit auto-clones a private copy of a real mission — three suggestion chips show what to ask your agent first; the clone includes a real pending approval to clear under your policy, an idle-ready task, and a splittable in-flight graph. Live worker execution runs on a contained private fleet (cost + security) and is demonstrated in the video.
