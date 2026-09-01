# Fleet evaluation harness

This npm-free Node 22 harness exercises the Fleet Contract v0 through HTTP. It runs ten isolated acceptance scenarios, prints a PASS/FAIL table, exits nonzero on any failure, and overwrites `eval/fleet/last-run.json` with a machine-readable summary.

## Self-test with the in-process stub

```sh
node eval/fleet/run.mjs --stub
```

The runner starts a fresh in-process HTTP stub for every scenario, so queue, cap, clock, project, and credential state cannot leak between cases. TTL tests advance the stub clock without sleeping. A successful run reports `10/10 passed` and exits 0.

## Test an integrated server and bridge

Start the enabled server and bridge first, using a disposable database and a seed with at least two ready, unassigned template tasks. Then run:

```sh
SEED_PROJECT_ID=your-seed-project \
REPORTER_TOKEN=your-supervisor-token \
FLEET_DISABLED_SERVER_URL=http://127.0.0.1:3101 \
node eval/fleet/run.mjs --real http://127.0.0.1:3100
```

`FLEET_DISABLED_SERVER_URL` must address a second disposable server started with `FLEET_MODE=0`; one process cannot switch the mode-only route registration at runtime. Real mode runs `daily-cap` after the other enabled scenarios because the cap is global for the UTC day. Every scenario still uses fresh visitor clones, and active requests are completed or expired before the next claim-oriented scenario.

Use a fresh database for each real run. Recommended enabled-stack settings are:

```text
FLEET_MODE=1
FLEET_DAILY_CAP=12
FLEET_PER_PROJECT_CAP=1
FLEET_ADOPT_TTL_MIN=1
FLEET_POLL_SEC=60
FLEET_EVAL_TIMEOUT_MS=180000
```

The one-minute adoption TTL keeps both expiry checks bounded. The longer bridge poll interval gives the harness time to exercise supervisor claim routes after the bridge proves the happy path. `FLEET_EVAL_TIMEOUT_MS` configures harness polling only; the other values configure the integrated server or bridge and must be set when those processes start.

In production, keep `FLEET_RUN_TTL_MIN` below `FLEET_ADOPT_TTL_MIN` as defense in depth. Accepted heartbeats refresh the adoption timestamp used by the server sweep, so only silent claims expire; the bridge watchdog should still terminate a wedged worker before the server lease can expire.

## Scenario matrix

1. `happy-path`: clone, human-presence dispatch, enqueue, adoption, worker lifecycle events in the clone ledger, and terminal `done`.
2. `template_mismatch`: a dispatched judge-authored custom task is rejected without changing queue depth.
3. `edited-brief`: a template clone dispatched with `brief_override` is rejected as `template_mismatch`, even when the override exactly equals the canonical brief. Contract v0 has no event that edits a task's canonical title or brief after creation, so this scenario cannot retain a separate canonical-edit variant.
4. `node_not_dispatched`: an otherwise matching template node is rejected before dispatch.
5. `per-project-cap`: the second request is capped, then accepted after the first adopted request expires.
6. `daily-cap`: the reported remaining UTC-day capacity is exhausted and the next request gets `fleet_daily_cap`.
7. `FIFO-fairness`: three clones enqueue in order and are claimed in the same order.
8. `TTL-expiry`: an un-heartbeated adoption expires and the next queued item is served.
9. `stale-claim`: a lifecycle event invalidates the oldest item; the same claim call fails it as stale and returns the next item.
10. `disabled-mode`: status remains probeable with zero capacity while every other fleet route returns `fleet_disabled`.

All responses are checked for the known supervisor token. The raw human-confirmation capability is allowed only in the action-confirmation response that contractually mints it, then every other response is checked for that value; fleet responses are also rejected if they expose privileged credential field names. Every clone ledger is re-read at scenario teardown and verified to contain only its own `project_id`, and the happy path checks a sibling clone does not gain worker events.

The real happy path intentionally waits for the running bridge. The other claim-oriented scenarios call the supervisor endpoints directly to make FIFO, TTL, and stale-skip assertions deterministic; use the recommended poll interval and a disposable stack.

Contract v0 interpretations exercised by the harness: raw human capability material appears only in the confirmation mint response; the global UTC daily cap counts every accepted request and never refunds; FIFO means one claim per call returns queued requests in enqueue order; and a judge-authored node that is an exact canonical title+brief copy of a seed template is accepted. That exact-copy behavior is a documented v0 limitation of content-hash eligibility.
