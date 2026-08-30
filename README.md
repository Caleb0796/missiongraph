# MissionGraph

## Seed a live development project

Start the server on the frontend development port, then replay the Shorty graph through its authenticated mutations API:

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

`seed:dev` prints a localhost URL containing the fresh project ID and visitor token. Open that URL to inspect the real server-backed graph. Set `MG_SERVER` to use a server other than `http://127.0.0.1:31337`.

The command writes every browser-authorized Shorty graph event through `POST /api/p/:project/mutations`; it does not invent worker reports. Reporter-only fixture handoffs, logs, deviations, and approval records remain visibly labeled simulation data and are intentionally excluded from the live seed.
