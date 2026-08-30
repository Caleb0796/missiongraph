# MissionGraph setup

## Prerequisites

Use Node 22, pnpm 9, Git, and Codex CLI 0.151.0 or newer. The target repository must already be a Git repository with at least one commit. Install and verify both packages with:

```sh
pnpm --dir server install --frozen-lockfile
pnpm --dir bridge install --frozen-lockfile
pnpm --dir server build
pnpm --dir bridge build
pnpm --dir bridge test
```

The integration test starts the real server package with a throwaway SQLite database, sends a real `TASK_ADDED` + `DISPATCHED` stream, and runs the bridge with its mock Codex executable.

## Project and credentials

Start the server with a high-entropy `REPORTER_TOKEN`, then create or clone a project. The current public creation path is:

```sh
curl --fail --silent --show-error -X POST http://127.0.0.1:3000/api/clone-demo
```

The response supplies `project`, `token`, and `cursor`. Use `project` as `MG_PROJECT_ID` and `token` as `MG_VISITOR_TOKEN`.

For a fresh local database, start the server once with the same `REPORTER_TOKEN` and `DB_PATH` you will use below, clone the project, then stop that bootstrap server. The one-command launcher reopens that database; changing `DB_PATH` would point it at a server that does not contain the cloned project.

Configure the bridge with environment variables or copy `bridge/config.example.json` to the ignored `bridge/config.json`. Environment variables take precedence:

| Environment variable | `config.json` key | Purpose |
|---|---|---|
| `MG_SERVER_URL` | `server_url` | Server origin, such as `http://127.0.0.1:3000` |
| `MG_PROJECT_ID` | `project_id` | Project identifier |
| `MG_VISITOR_TOKEN` | `visitor_token` | Project token used by snapshot and SSE requests |
| `MG_REPORTER_CREDENTIAL` | `reporter_credential` | Bearer credential used by supervisor/worker reports |
| `MG_TARGET_REPO` | `target_repo_path` | Absolute path to the Git repository workers modify |
| `MG_CODEX_PATH` | `codex_binary_path` | Codex executable; default `codex` |
| `MG_CODEX_MODEL` | `model` | Codex model; default `gpt-5.6-sol` |
| `MG_CODEX_EFFORT` | `effort` | Reasoning effort; default `high` |
| `MG_BRIDGE_STATE` | `state_path` | Persistent cursor/thread/worktree state; default `bridge/state.json` |

`config.json` and `state.json` are gitignored. Prefer environment-secret injection on a VM and restrict any file containing credentials to mode `0600`.

### Reporter credentials (CONTRACTS v1.3)

The process-wide `REPORTER_TOKEN` authorizes actor `supervisor` only. Worker events use short-lived credentials minted via `POST /api/p/:project/reporter-credentials` (supervisor bearer auth; body `{actor: "worker:<node_id>"}`; response `{token, actor, expires}`; project- and actor-bound, 15-minute TTL, renewable by re-calling — renewal mints an additional credential and earlier ones lapse at their original expiry). The bridge mints one before every worker spawn, renews long-running workers before expiry, and refreshes expired credentials on later worker turns. `/report` accepts `JOURNAL_NOTE` from actor `supervisor` (the §5b `note` transport); workers may not journal. Set `MG_REPORTER_CREDENTIAL` to the supervisor-scope `REPORTER_TOKEN`.

## One-command local bring-up

After exporting or replacing the values below, this single command installs, builds, starts the real server, waits for the configured project, and runs the full bridge pump in dry-run mode:

```sh
REPORTER_TOKEN='replace-process-secret' \
MG_SERVER_URL='http://127.0.0.1:3000' \
MG_PROJECT_ID='replace-project-id' \
MG_VISITOR_TOKEN='replace-visitor-token' \
MG_REPORTER_CREDENTIAL='replace-process-secret' \
MG_TARGET_REPO='/absolute/path/to/demo-repo' \
DB_PATH='/tmp/missiongraph.sqlite' \
PORT='3000' \
sh -c 'set -eu
  (cd server && pnpm install --frozen-lockfile && pnpm build)
  (cd bridge && pnpm install --frozen-lockfile && pnpm build)
  (cd server && pnpm start) &
  server_pid=$!
  trap '\''kill "$server_pid" 2>/dev/null || true'\'' EXIT INT TERM
  attempts=0
  until curl --fail --silent --show-error -H "x-mg-token: $MG_VISITOR_TOKEN" "$MG_SERVER_URL/api/p/$MG_PROJECT_ID/snapshot" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 100 ] || exit 1
    sleep 0.1
  done
  (cd bridge && pnpm start -- --dry-run)'
```

`--dry-run` replaces Codex with `bridge/mock-codex.mjs`; server, SSE, FIFO, decision parsing, worktree creation, and state persistence remain real. Remove `--dry-run` to run real Codex sessions (verified end-to-end 2026-08-30, PROGRESS.md M3). The bridge launches Codex with the probe-verified flags, disables configured MCP servers with `-c mcp_servers={}`, and gives every child ignored stdin—the programmatic equivalent of `< /dev/null`.

## VM spend controls

Before deploying the server and bridge to a VM:

- Set a provider-level monthly hard budget or the lowest available spend alert, disable autoscaling, and run one bounded instance.
- Set an OpenAI/Codex account or project spend limit separately; the VM budget does not cap model usage.
- Keep the supervisor policy at two automatic critical-path workers plus the single explicit-dispatch slot. Do not increase it for the public demo.
- Use `--dry-run` while validating transport/configuration, and stop the VM when it is not needed outside the judging window.
- Never place reporter credentials in image layers, Git, shell history, or command arguments; inject them through the VM secret environment.

## Codex lifecycle

The bridge persists the supervisor `thread_id` and resumes it across bridge restarts. Fresh supervisors and workers use `codex exec ... --json` with workspace-write/network access and `mcp_servers={}`. Envelope delivery and cooperative worker commands use one-at-a-time `codex exec resume <thread_id> '<one-line JSON>' ... --json` turns. Worker briefs require queued→running→review/failed transitions, log tails, a version-1 `HANDOFF_FILED`, and one `APPROVAL_CREATED`; workers commit in isolated worktrees and never auto-merge.
