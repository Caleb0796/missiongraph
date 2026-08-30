# MissionGraph server

Node 22 server for the MissionGraph append-only event log, graph projections, HTTP mutations, and read-only WebSocket/SSE streams.

## Run

Install dependencies with `pnpm install`, set `REPORTER_TOKEN`, then start the development server:

```sh
pnpm dev
```

The server listens on `0.0.0.0:3000` by default and stores data in `missiongraph.sqlite`.

## Environment

| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `REPORTER_TOKEN` | yes | — | Bearer secret used only by supervisor and worker reporters. |
| `DB_PATH` | no | `missiongraph.sqlite` | Path to the single SQLite database file. |
| `PORT` | no | `3000` | HTTP, WebSocket, and SSE port. |
| `SEED_PROJECT_ID` | no | `demo-seed` | Source event stream cloned by `/api/clone-demo`. |

Visitor tokens are generated per cloned project and sent as `x-mg-token`. A browser-agent mutation may additionally set `x-mg-actor: browser_agent`; mutations default to the `human` actor.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/p/:project/mutations` | `x-mg-token` | Append a human or browser-agent mutation. Body: `{type, payload, idem_key, base_seq?}`. |
| `POST` | `/api/p/:project/report` | `Authorization: Bearer $REPORTER_TOKEN` | Append a supervisor or `worker:<id>` fleet event. |
| `GET` | `/api/p/:project/snapshot` | `x-mg-token` | Return the deterministic graph state and current cursor. |
| `POST` | `/api/clone-demo` | none | Clone the configured seed stream into an isolated project, remap entity IDs, and issue its visitor token. |
| `GET` | `/ws?project&from_seq&token` | query token | Replay events strictly after `from_seq`, then stream live events server-to-client. Without `from_seq`, sends a snapshot first. |
| `GET` | `/sse?project&from_seq&token` | query token | Read-only SSE fallback with the same replay and snapshot behavior as WebSocket. |

Run verification with `pnpm test` and `pnpm build`.
