# MissionGraph

**Mission control for graph-parallel agent engineering.** A live task-DAG canvas where a human, their browser agent (via [WebMCP](https://developer.chrome.com/docs/ai/webmcp)), and a fleet of Codex worker sessions run a software project together — and every decision, handoff, and deviation stays on the record.

> *The intelligence already sits in the visitor's browser — their own agent, with their context and their authority. WebMCP gives that agent hands on shared, live project state that DOM manipulation could never reach (a canvas DAG), and gives the page a way to mirror human context back (selection → dynamic tools). Human + browser agent + worker fleet each do what only they can: judgment, narration + policy execution, throughput.*

Live: **https://missiongraph.vercel.app** · WebMCP Challenge entry (Devpost)

## What humans and agents can do together here that they couldn't before

Parallel agent fleets are fast — and illegible. A linear chat loop is legible — and slow. MissionGraph makes **supervision-by-exception of a parallel agent fleet** possible through one shared living graph:

- **S1 · Genesis** — describe the mission in a paragraph; your browser agent plans it as a dependency DAG on the canvas (`plan_seed`), you drag, it splits oversized nodes; the critical path ignites.
- **S2 · Flight** — real Codex workers execute in parallel. Ask your agent to *catch you up* (`graph_digest` narrates everything you missed), state a one-sentence approval policy and let the agent clear the review queue under it (`policy_ref` on every agent approval — auditable), staff the idle branch the radar found.
- **S3 · Rewire** — mid-flight you split a running task: the blast radius (stale/pausing work) is previewed before anything applies, workers get re-briefed, the critical path re-routes live.

## Architecture

```
 human ──── canvas UI (React Flow + elkjs) ────┐
                                               │ WS / HTTP (event-sourced)
 browser agent (ChatGPT / any WebMCP client)   │
   └── 20+ WebMCP tools on document.modelContext ──► server (Node 22 · Fastify · SQLite)
                                               │      append-only event ledger
                                               │      fold reducer · digest ranking
 Codex fleet ── bridge daemon ── SSE + `codex exec resume`
   supervisor session (brain: JSON decisions)  │
   worker sessions (hands: isolated git worktrees, node-bound 15-min credentials)
```

- **One event ledger** is the single source of truth. Every actor is labeled (`human`, `browser_agent`, `supervisor`, `worker:<id>`); every state you see is a fold of the ledger; any client resumes from any cursor.
- **Digest pattern**: every tool result carries `cursor` + `changes_since`, so a browser agent that was away five minutes is fully caught up by its next call — the page never needs to wake it.
- **Supervisor = brain, server = hands**: the Codex supervisor only ever emits structured decisions (spawn / pause / rebrief / note); the bridge executes them mechanically, so *every scheduling decision is an auditable recorded turn*.
- **Audit-first UX**: nodes and edges open into dossiers (Brief / Handoff / Deviations / Decisions / Log — prose first, never bare IDs). Workers must file structured handoffs; deviations feed the rewire radar; everything else lands in the project journal.
- **Real history only (C5)**: the demo seed every visitor clones is an export of a *real* run — actual Codex workers, actual commits, actual approvals. Nothing is fabricated.

## Try it

**Browsers**: ChatGPT's built-in browser — native WebMCP; needs the latest app, model GPT-5.6 Sol or Terra (Luna has WebMCP disabled), and Settings → Browser → Permissions → "Enable site tools" turned on. Or Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled. The page shows an enable banner when WebMCP is absent (a labeled offline fixture keeps the canvas explorable).

Ask your agent things like: *"Catch me up on this mission."* · *"Approve anything under 50 changed lines with green tests — that's my policy."* · *"What's idle and worth staffing?"* · *"Split the containerize task into build and deploy halves — show me the blast radius first."*

**Local bring-up**: see [SETUP.md](SETUP.md) (server + bridge one-command launch, credentials hygiene, VM spend controls). Frontend: `cd app && pnpm install && pnpm dev`.

<details><summary>Seed a live development project</summary>

Start the server, then replay the Shorty graph through its authenticated mutations API:

```sh
cd server
REPORTER_TOKEN=dev-only PORT=31337 pnpm dev
```

In another terminal:

```sh
cd app
pnpm seed:dev
pnpm dev
```

`seed:dev` prints a localhost URL containing the fresh project ID and visitor token; set `MG_SERVER` to target a server other than `http://127.0.0.1:31337`. It writes only browser-authorized graph events through `POST /api/p/:project/mutations` — it does not invent worker reports. Fixture-only handoffs/logs remain visibly labeled simulation data (C5).

</details>

## Testing

121 tests across the three packages (CI runs them on every push):

```sh
cd server && pnpm test   # 30 — event store, reducer (22 event types), digest ranking, HTTP auth/CORS/batch atomicity, seed pipeline round-trip
cd bridge && pnpm test   # 41 — decision validation, action ledger crash replay, PID-identity kill safety, lock takeover races, credential renewal, dry-run integration against a real server
cd app    && pnpm test   # 50 — tool envelope contract, identity-epoch fencing, reconnect/re-clone paths, split preview/confirm, and a real-server HTTP regression driving plan→preview→confirm end-to-end
```

Beyond unit/integration tests, every milestone went through an **adversarial review loop** (independent reviewer session → findings → fix round → fix-verification round) and a **live functional arbitration** on the real stack — 50+ P1/P2 findings found and closed this way, with the full trail in [PROGRESS.md](PROGRESS.md).

## Repository layout

| Path | What |
|---|---|
| `app/` | Vite/React canvas + the WebMCP tool surface (3-tier registration fallback for Chrome 152/153+) |
| `server/` | Event-sourced core: ledger, reducer, digest, reporter credentials, seed pipeline |
| `bridge/` | Codex fleet daemon: SSE→supervisor envelope pump, decision executor, worker lifecycle |
| `docs/CONTRACTS.md` | The frozen interface contract every track builds against |
| `GOAL_PLAN.md` | The full mission plan (pain points → scenarios → milestones) |
| `PROGRESS.md` | Milestone-by-milestone evidence log, including adversarial review rounds |

MIT © 2026 — built for the OpenAI WebMCP Challenge.
