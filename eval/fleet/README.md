# Fleet evaluation harness

This npm-free Node 22 harness exercises the Fleet Contract v0 through HTTP. It runs 16 isolated acceptance and mirror-consistency scenarios, prints a PASS/FAIL/SKIP table, exits nonzero on any failure, and overwrites `eval/fleet/last-run.json` with a machine-readable summary.

## Self-test with the in-process stub

```sh
node eval/fleet/run.mjs --stub
```

The runner starts a fresh in-process HTTP stub for every scenario, so queue, cap, clock, project, and credential state cannot leak between cases. TTL and UTC-rollover tests advance the stub clock without sleeping. A successful run reports `16 passed, 0 failed, 0 skipped` and exits 0.

## Stub mirror contract

The stub is a server MIRROR, not an independent mock specification. Any fleet behavior change in `server/src/fleet.ts` must update the stub and its regression scenarios in the same change. Keep these semantics synchronized:

- Daily usage counts requests created in the current UTC day, including requests that later expire, and resets at the UTC boundary. Scenario expectations come from the configured cap, never from `daily_remaining` itself.
- Project-cap and duplicate checks exclude expired requests, so an expired node can be enqueued again. Sweeping sets `status: "expired"` and `finished_at` but leaves `outcome` absent/null.
- Eligibility folds the configured seed project's active task records. The seed project itself is rejected, while seed additions and tombstones immediately change the template registry.
- Eligibility classification follows server order: task record, non-seed project, queued state plus assigned projection and no worker lifecycle, no dispatch brief override, then template hash.
- Claim-time `template_mismatch` remains that outcome; other eligibility failures become `stale` while the claim loop advances in FIFO order.

The scenario matrix is the mechanical drift check. Seed-registry mutation and deliberately desynchronized projection cases are stub-only because the integrated runner has no seed-project visitor credential; real mode reports them as `SKIP` instead of treating them as passes.

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
2. `seed-project-rejection`: the configured seed itself is never fleet-eligible (stub-only).
3. `seed-registry-addition`: a newly added active seed task becomes eligible in subsequent clones (stub-only).
4. `seed-registry-tombstone`: removing a seed task invalidates its prior clone template (stub-only).
5. `template_mismatch`: a dispatched judge-authored custom task is rejected without changing queue depth.
6. `undispatched-custom-precedence`: an undispatched custom task is classified as `node_not_dispatched` before its hash is checked.
7. `edited-brief`: a template clone dispatched with `brief_override` is rejected as `template_mismatch`, even when the override exactly equals the canonical brief.
8. `node_not_dispatched`: an otherwise matching template node is rejected before dispatch.
9. `eligibility-projection`: task record type, queued state, and assigned projection determine eligibility rather than stub-only flags (stub-only).
10. `per-project-cap`: the second request is capped, then the same node is accepted after its first adopted request expires.
11. `daily-cap`: the externally configured UTC-day capacity is exhausted, the next request is capped, and the stub clock rollover restores the configured capacity.
12. `FIFO-fairness`: three clones enqueue in order and are claimed in the same order.
13. `TTL-expiry`: an un-heartbeated adoption expires without an outcome and the next queued item is served.
14. `claim-template-mismatch`: a template hash changed after enqueue fails with `outcome: "template_mismatch"` at claim (stub-only).
15. `stale-claim`: a lifecycle event invalidates the oldest item; the same claim call fails it as stale and returns the next item.
16. `disabled-mode`: status remains probeable with zero capacity while every other fleet route returns `fleet_disabled`.

All responses are checked for the known supervisor token. The raw human-confirmation capability is allowed only in the action-confirmation response that contractually mints it, then every other response is checked for that value; fleet responses are also rejected if they expose privileged credential field names. Every clone ledger is re-read at scenario teardown and verified to contain only its own `project_id`, and the happy path checks a sibling clone does not gain worker events.

The real happy path intentionally waits for the running bridge. The other claim-oriented scenarios call the supervisor endpoints directly to make FIFO, TTL, and stale-skip assertions deterministic; use the recommended poll interval and a disposable stack.

Contract v0 interpretations exercised by the harness: raw human capability material appears only in the confirmation mint response; the global daily cap counts every request accepted within the current UTC day and never refunds within that day; FIFO means one claim per call returns queued requests in enqueue order; and a judge-authored node that is an exact canonical title+brief copy of an active seed task is accepted. That exact-copy behavior is a documented v0 limitation of content-hash eligibility.
