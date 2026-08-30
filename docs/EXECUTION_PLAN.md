# EXECUTION_PLAN.md — fleet topology (quota-abundant mode, 2026-08-30)

Premise: Codex quota is NOT the constraint. The real constraints are (a) the M0 compat gate, (b) merge complexity, (c) human-account steps. Topology attacks the two scariest unknowns in hour zero, forks tracks behind frozen contracts, and converges before polish.

Orchestrator: Claude (this session) — holds full design context, freezes contracts, reviews every merge to `main`, runs cross-track consistency checks, queues corrections into sessions. Codex sessions do not share memory; coordination = git + CONTRACTS.md + orchestrator.

## Phase 0 — Gate & Probe (10:00 → ~11:00), 2 sessions in parallel

**S1 "pathfinder"** (repo root, branch `track/frontend`):
M0 frontend half — Vite+TS scaffold, WebMCP wrapper per docs/webmcp-notes.md, `hello_missiongraph` (envelope-compliant), in-page self-test via getTools()/executeTool(), deploy to Vercel. STOP → human verifies in ChatGPT browser + Chrome ≥153.

**S2 "quartermaster"** (separate dir `~/mg-probe`, throwaway):
Empirical CLI probe pulled forward from M3 — verify live `codex queue` syntax, session spawn/resume lifecycle, worktree behavior, and a minimal reporter-style HTTP callback from inside a session. Deliverable: PROBE.md with exact working commands. Then scaffold the URL-shortener demo repo (`~/mg-shorty`): Fastify + SQLite, ~10 files, tests, README.

Exit gate: M0 DoD passes in BOTH browsers AND PROBE.md confirms the bridge surface. Any failure = all hands on the failing item; nothing else merges.

## Phase 1 — Three tracks (post-gate → end of day 1), 3 build sessions

| Session | Worktree | Scope | Key deliverables |
|---|---|---|---|
| S1 frontend | `track/frontend` | Track A+C: canvas (React Flow+elkjs), node anatomy, critical path viz, dossier inspector, THEN the WebMCP tool layer (24 tools against CONTRACTS §3, server mocked by fixtures) | M1 visuals + M2 tools |
| S3 server | `track/server` | Track B: event store+reducer (CONTRACTS §1-2), snapshot/mutations/report endpoints, WS broadcast, digest projection, 409 concurrency | M1 server half + M3 server half |
| S2 bridge | `track/bridge` | Track D: supervisor brief template (autopilot defaults §13), queue envelope sender, worker launch via worktrees, reporter client helper, handoff schema enforcement | M3 bridge half |

Merge cadence: orchestrator merges each track to `main` at 2-3 checkpoints/day after review; contract disputes resolved by orchestrator amending CONTRACTS.md (version bump, all sessions notified via queue).

## Phase 2 — Converge & harden (day 2 → day 3), 2 sessions + reviewers

- **S-integrate** (single owner of `main`): wire tracks together; M2 DoD → M3 DoD end-to-end (real dispatch on mg-shorty); M4 (policy approvals, idle radar, retry); M5 (split+blast radius, contextual tools — needs Chrome ≥153 verified).
- **S-adversary** (fresh session per milestone): `codex review`/challenge on each merged milestone diff — quota-abundant upgrade: adversarial pass EVERY milestone, not just at the end. P0/P1 findings fixed before the next milestone starts.
- **Seed farming** (background, doubles as M3 testing): run the real supervisor+workers on mg-shorty repeatedly; keep the best-looking REAL run as the demo seed (C5: curation among real runs is allowed; editing them is not).

## Phase 3 — Ship (day 3.5 → Sep 2 night), 1 session + human

- **S-ship**: seed import + per-visitor clone endpoint, suggestion chips, README, MIT license, submission text from GOAL_PLAN §10, SETUP.md.
- Human + orchestrator: video capture per §9 storyboard (real screen, OUR live instance), YouTube upload, Devpost submission — target **Sep 2 evening**, keeping Sep 3 morning as pure buffer.
- Final: full `codex review` of entire repo + orchestrator compliance sweep against §10 checklist + judging-window ops check (VM keep-alive, spend caps).

## Quota-abundant upgrades (explicitly enabled by ample quota)

1. Adversarial review per milestone (S-adversary), ultra effort.
2. Spike-before-thick-tool: throwaway pathfinder sessions for plan_seed layout, split blast-radius, dispatch loop — validate approach in isolation before building in-track.
3. Seed farming: many real runs, pick the most legible history.
4. Ultra reasoning effort as default for reducer/digest/blast-radius work; medium for boilerplate.
5. Parallel S2/S3 demo-beat rehearsal sessions before video capture.

## What stays serial no matter the quota

M0 gate; CONTRACTS freezes; merges to `main` (one owner); video capture; every human-account step (Devpost, Vercel, Render, Chrome update, YouTube).

## Session kickoff prompts

**S1:** "Read AGENTS.md, GOAL_PLAN.md, docs/webmcp-notes.md, docs/CONTRACTS.md. You are S1-pathfinder on branch track/frontend. Execute the M0 frontend half ONLY: scaffold, WebMCP wrapper, hello_missiongraph, in-page self-test, Vercel deploy. Stop for human browser verification. Evidence into PROGRESS.md, commit each step."

**S2:** "Read AGENTS.md, GOAL_PLAN.md §5/§13, docs/CONTRACTS.md §5. You are S2-quartermaster working OUTSIDE this repo in ~/mg-probe. Empirically verify the live codex CLI surface: queue to a running session, spawn/resume lifecycle, worktree isolation, HTTP callback from inside a session. Write PROBE.md with exact working commands — never guess from docs. Then scaffold ~/mg-shorty (Fastify+SQLite URL shortener, ~10 files, tests). Report back verbatim findings."

**S3 (post-gate):** "Read AGENTS.md, GOAL_PLAN.md, docs/CONTRACTS.md (§1-§4 are your bible). You are S3-server on branch track/server. Build the event store, versioned reducer, snapshot/mutations/report endpoints, WS broadcast, digest projection, 409 concurrency — exactly to contract. Fixtures for every event type. Evidence into PROGRESS.md."
