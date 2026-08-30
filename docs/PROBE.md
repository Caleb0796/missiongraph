# PROBE.md — empirical codex CLI findings (0.144.6, verified 2026-08-30)

All commands below were EXECUTED and verified on this machine. Observed reality; do not re-derive from docs.

## Verdicts

| # | Question | Verdict | Evidence |
|---|---|---|---|
| P0 | Does `codex queue` exist? | **NO** — not a subcommand in 0.144.6 (newer versions only). Delivery mechanism = `codex exec resume`. | `codex --help` lists no queue |
| P1 | Fresh session + structured JSON reply + thread id capture | ✅ | `thread.started` event carries `thread_id`; agent_message returned exact JSON |
| P2 | Envelope delivery via resume | ✅ | `codex exec resume <tid> 'ENVELOPE: {...}'` → `{"probe":"P2","ack_seq":1}` |
| P3 | Session memory ACROSS resumes | ✅ | next resume answered `{"remembered_seq":1}` — supervisor can hold state between deliveries |
| P4 | Worktree isolation for workers | ✅ | worker wrote in `wt1`, main checkout untouched |
| P5 | Network from workspace-write sandbox | ✅ | `-c 'sandbox_workspace_write.network_access=true'` → in-session curl POST reached local HTTP server |

## Exact working commands

Spawn a session (capture `thread_id` from the `thread.started` JSONL event):
```bash
codex exec "<brief>" -s workspace-write -c 'sandbox_workspace_write.network_access=true' \
  -c 'mcp_servers={}' -c 'model_reasoning_effort="high"' --json < /dev/null > out.jsonl 2>err.log
```

Deliver an envelope to an existing session (the queue substitute; NOTE: resume rejects `-C` and `-m` — run from the target cwd, model is sticky per session):
```bash
codex exec resume <thread_id> '<one-line JSON envelope>' \
  -c 'sandbox_mode="workspace-write"' -c 'mcp_servers={}' --json < /dev/null
```

Worker in an isolated worktree:
```bash
git worktree add ../wt-<node> -b work/<node>
codex exec "<worker brief>" -C ../wt-<node> -s workspace-write \
  -c 'sandbox_workspace_write.network_access=true' -c 'mcp_servers={}' --json < /dev/null
```

## Gotchas (repeat offenders)

- `codex exec resume` REJECTS `-C` and `-m`. cd first; the session keeps its original model.
- Non-git cwd needs `--skip-git-repo-check` on `codex exec` (not needed once a repo exists).
- Always pass `-c 'mcp_servers={}'`: the user config carries an Oracle dbtools MCP server that emits fatal-looking (harmless) AuthRequired stderr noise and adds startup latency.
- stderr also shows a models-cache warning (`missing field base_instructions`) — harmless.
- Always `< /dev/null` — codex reads stdin otherwise ("Reading additional input from stdin...").
- Model availability on this account: `gpt-5.6-sol` (+ `model_reasoning_effort="ultra"` OK); `gpt-5.6-sol-max` → HTTP 400.

## Addendum — CLI updated to 0.151.0 (2026-08-30, later same day)

- `codex queue` now EXISTS ("Queue a message for an existing session"). Bridge decision UNCHANGED: `exec resume` stays the primary delivery (each envelope = one auditable turn whose output is the §5b decision JSON; queue is fire-and-forget with no capturable response stream). `queue` is approved only as an optional side-channel for FYI-class events needing no decision. M3 opens with a fresh probe of `codex queue --help` syntax before any use.
- `exec resume` now ACCEPTS `-m` (0.144.6 rejected it); also gained `--last`/`--all`. Re-verify `-C` behavior at M3.
- Version 0.151.0 is not on the known-bad list. Sessions already running on 0.144.6 are unaffected.

## Architectural consequence (CONTRACTS v1.1)

Server holds the envelope FIFO; ONE in-flight `exec resume` to the supervisor at a time; each supervisor decision is a discrete, auditable turn. The supervisor is the BRAIN (its turn output = decision JSON); the SERVER is the hands (spawns worker sessions per decision). C4 boundary intact and now trivially auditable: every scheduling decision exists as a recorded supervisor turn.
