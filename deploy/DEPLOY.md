# Production deployment (Render VM + Vercel frontend)

Two deployables: the **Vercel frontend** (already live at https://missiongraph.vercel.app) and the **Render web service** (event-sourced server + env-gated Codex bridge, one Docker image, persistent disk).

Human-account steps run in the owner's browser (Render/Vercel dashboards). Secrets are entered ONLY in dashboard env fields — never in git, shell history, or chat.

## 1. Create the Render service

Render dashboard → **New → Blueprint** → select this repo → it reads the repo-root `render.yaml`. Before first deploy confirm:

- Plan: starter (one bounded instance, autoscaling off — spend control).
- Disk `mg-data` mounted at `/data` (SQLite + bridge state + target repo live there).
- `REPORTER_TOKEN` auto-generated (this is the supervisor-scope secret).
- `ALLOWED_ORIGINS=https://missiongraph.vercel.app` (CORS is fail-closed).
- Account-level: set a monthly hard budget / lowest spend alert.

Deploy. Note the service URL, e.g. `https://missiongraph.onrender.com`.

## 2. Point the frontend at the VM

Vercel dashboard → missiongraph project → Settings → Environment Variables → set `VITE_MG_SERVER` to the Render URL (absolute HTTPS origin) → redeploy. Without it the page stays in labeled fixture mode.

## 3. Verify the empty server

```sh
curl -s https://<render-url>/api/health
```

Then load the Vercel URL: first visit should clone a project (fixture seed for now) and show LIVE.

## 4. Import the real-run seed (C5)

From the machine holding the real-run project (local dev box):

```sh
# export locally (visitor token of the real project)
curl -s -H "x-mg-token: $LOCAL_TOKEN" \
  "http://127.0.0.1:31337/api/p/$LOCAL_PROJECT/export" > seed.json

# import on the VM (supervisor bearer = the Render REPORTER_TOKEN, read from env)
curl -s -X POST -H "content-type: application/json" \
  -H "authorization: Bearer $RENDER_REPORTER_TOKEN" \
  --data-binary @seed.json \
  "https://<render-url>/api/import-seed"
```

Response gives `project_id`. Set `SEED_PROJECT_ID=<project_id>` in Render env → redeploy. Every fresh visitor now clones the real mission history.

## 5. Enable the flagship fleet (optional until demo week)

Clone one flagship mission (POST `/api/clone-demo`), keep its `project`/`token`. In Render env set: `BRIDGE_ENABLED=1`, `MG_PROJECT_ID`, `MG_VISITOR_TOKEN`, `MG_TARGET_REPO_URL` (a public demo repo the workers may modify — use a throwaway fork), `OPENAI_API_KEY` (project-scoped key with a **hard spend cap**; NEVER a ChatGPT login on the VM), `MG_CODEX_MODEL`. Redeploy.

**Codex ignores `OPENAI_API_KEY` in the environment.** Given only the variable it sends no credential at all and every worker dies on `Missing bearer or basic authentication in header`. `entry.sh` therefore pipes the key into `codex login --with-api-key` on boot, writing the credential to `CODEX_HOME=/data/codex` (700, on the persistent disk, inherited by worker children through the existing `CODEX_`/`OPENAI_` allowlist). It then runs one throwaway `codex exec` to prove the key can actually reach `MG_CODEX_MODEL`, and refuses to start the bridge if it cannot — better one clear boot failure than a stream of adopted tasks dying after the judge already confirmed them. Both steps read the key from stdin, never from argv.

**Zero-downtime deploys and the bridge lock.** During a deploy the old and new instances briefly share `/data`, so the new bridge's first start loses the state lock and exits; `entry.sh` retries on a bounded loop (30 × 30s) and the old instance releases the lock as it shuts down (entry.sh forwards SIGTERM so the bridge's graceful stop actually runs). If the log keeps showing `bridge state lock … is held on host <old-instance>` past ten minutes, the loop moves the leftover lock aside itself; as a manual last resort, delete `/data/bridge-state.json.lock` from a shell and restart the service.

**Worker sandbox on Render.** Codex's Linux sandbox is bubblewrap, which needs user namespaces; Render's runtime forbids them, so a sandboxed worker's every shell command fails at `bwrap: setting up uid map: Operation not permitted` and the worker exits without reporting. `render.yaml` therefore sets `MG_CODEX_SANDBOX=danger-full-access` (set it in the dashboard env as well). Compensating controls: single-tenant container, workers briefed only on their git worktree, and no secret in the worker environment. `entry.sh` logs a `worker-mode probe` line at boot showing exactly what a worker's shell sees.

Flip `BRIDGE_ENABLED=1` **last**, after every other variable is in place: while it is `0` there is no worker process on the VM, so nothing can be spent and nothing can execute.

### Judge fleet (a clone may borrow the bridge for ONE human-confirmed, template-bound task)

Set `FLEET_MODE=1` on the same service to open the fleet routes and the bridge's adoption loop; `FLEET_DAILY_CAP`, `FLEET_PER_PROJECT_CAP`, `FLEET_ADOPT_TTL_MIN` and `FLEET_RUN_TTL_MIN` carry the defaults declared in `render.yaml`. With `FLEET_MODE` unset or `0`, the status route reports `enabled: false`, request and worker routes return `fleet_disabled`, and the bridge never polls, so the merged code is inert.

Worst-case spend is bounded by `FLEET_DAILY_CAP` × judging days. Set a hard spend limit on the API key itself as well — that limit is the only backstop that does not depend on this code being correct.

Supervisor policy stays at two automatic critical-path workers + one explicit-dispatch slot (GOAL_PLAN §13); do not raise it for the public demo.

## 6. Judging-window checklist

- VM + frontend stay up through **Sep 21**; suspend the service after judging.
- Test the exact judge path daily from a fresh Chrome profile (flag on) AND the ChatGPT built-in browser: clone → chips → catch-up → approve-under-policy → idle radar.
- `--dry-run` is for transport validation only and must never point at the seed or flagship database.
