# AGENTS.md — MissionGraph working rules for Codex

## What this repo is

WebMCP Challenge entry (Devpost, deadline **Sep 3 2026 13:00 PDT**). The full contract is **GOAL_PLAN.md** — read it entirely before any work. Precedence: JSON schemas in code > §13 Executor clarifications > §4 shorthand. You already reviewed this plan in a prior session (two comprehension rounds); §13 ratifies your assumptions — they are now binding decisions.

## How to work

- Execute ONE milestone at a time (M0→M6), in order. Each has a DoD in §8. Do not start M(n+1) before M(n) passes.
- **Hard stops:** M0 compat-gate failure in the ChatGPT browser (report, do not improvise around it); anything needing human accounts/credentials (see docs/HUMAN_CHECKLIST.md); any change to GOAL_PLAN semantics (propose, never self-amend).
- **Commit discipline:** small conventional commits (`feat:` / `fix:` / `chore:` / `docs:`), at minimum one per DoD. Timestamped in-window commit history is a COMPETITION REQUIREMENT — commit early and often. Never commit secrets or `.env*`.
- **After each milestone:** update `PROGRESS.md` — what passed, evidence (exact commands, URLs, browser versions), deviations from plan.
- **Constraints that void the entry if broken:** C5 no fabricated execution/history; C4 no homegrown scheduler (Codex primitives only); C3 video is real capture only.
- Package manager: pnpm. Node 22. TypeScript everywhere.
- Do not read or modify `.context/`, `~/.claude/`, or anything outside this repo.

## Environment facts (probed 2026-08-30 — trust these, do not re-probe)

- node v22.23.1, pnpm 9.15.9, npm 10.9.8, python 3.14.6, git 2.54.0
- gh CLI 2.96.0, authenticated as `Caleb0796` (https protocol) — repo creation/push works
- vercel CLI: NOT installed (install via `pnpm add -g vercel`, or deploy via dashboard); render CLI: not installed (use render.yaml blueprint / dashboard)
- Chrome installed: **152.0.7977.64 — BELOW the 153 needed for AbortController tool unregistration; human must update Chrome before contextual-tools testing** (flag: `chrome://flags/#enable-webmcp-testing`)
- ChatGPT.app installed (its built-in browser supports WebMCP natively — primary test target)
- codex CLI 0.144.6 at /opt/homebrew/bin/codex; auth present. Quirks: `codex exec resume` rejects `-C`/`-m`; stderr always shows a harmless Oracle-dbtools MCP AuthRequired error + a models-cache warning — ignore both; best available model on this account: `gpt-5.6-sol` (`gpt-5.6-sol-max` returns 400)
- WebMCP API contract pinned in **docs/webmcp-notes.md** (registerTool shape, string returns, toolchange, permissions policy)

## Key references

- GOAL_PLAN.md — the contract; docs/webmcp-notes.md — pinned API facts
- WebMCP spec: https://github.com/webmachinelearning/webmcp
- Chrome docs: https://developer.chrome.com/docs/ai/webmcp (imperative-api subpage has the canonical snippet)
- Chrome demos: https://github.com/GoogleChromeLabs/webmcp-tools · React hook: `usewebmcp` (npm)
- Challenge rules: https://webmcp.devpost.com/rules

## Multi-session mode

Execution runs as a FLEET (see docs/EXECUTION_PLAN.md): your kickoff prompt names your session id (S1/S2/S3…), track, and worktree branch. Stay in your lane — commit only to your track branch, never touch other tracks' files, never merge to `main` (the orchestrator does, after review). **docs/CONTRACTS.md is frozen**: build exactly to it; if it blocks you, write the issue in PROGRESS.md and continue on what's unblocked — the orchestrator amends contracts, you don't. Milestone discipline applies per track.

## Kickoff prompt (for the human to paste)

> Read AGENTS.md and GOAL_PLAN.md fully. Execute milestone M0 ONLY. Self-test tool registration in-page via getTools()/executeTool() first, then verify in the ChatGPT built-in browser and flagged Chrome. Stop when M0's DoD passes or the compat gate fails; either way write PROGRESS.md with evidence and commit.
