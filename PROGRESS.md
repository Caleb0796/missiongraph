# PROGRESS

| Milestone | Status | Evidence | Deviations |
|---|---|---|---|
| M0 scaffold + compat spike | **GATE PASSED on flagged Chrome 152** (human-verified 2026-08-30 ~18:17Z): namespace=`document`, dynamic-tools tier=`abort-controller` (detection-level), `hello_missiongraph` returned the exact contract envelope incl. `env.api:"document"`, UA Chrome/152.0.0.0. Deployed: https://missiongraph.vercel.app. ChatGPT-browser verification DEFERRED by human decision — REQUIRED before submission (C6). Two fixes from gate evidence: cycle-safe formatRaw (`62dd298`), React Flow dimension persistence (`d0bb316`). | S1 `track/frontend` commit `b7468f6`. Scaffold: `pnpm create vite app --template react-ts`; dependencies: `pnpm install`, `pnpm add -D tailwindcss @tailwindcss/vite` (Tailwind 4.3.3). `cd app && pnpm build` PASS (`tsc -b && vite build`, Vite 8.2.2, 17 modules); `pnpm lint` PASS (oxlint 1.80.0); `pnpm dev --host 127.0.0.1` served `http://127.0.0.1:5173/`; `curl --fail --silent --show-error http://127.0.0.1:5173/` PASS and returned HTML titled `MissionGraph WebMCP Compatibility`. Environment versions from the trusted 2026-08-30 probe: Node 22.23.1, pnpm 9.15.9, Chrome 152.0.7977.64. | Historical: deploy was blocked pre-login (resolved same day: `vercel login` + prod deploy). Docs-level note: the official Chrome page shows `executeTool(discoveredTool, jsonInputString)` — self-test uses the discovered tool object, confirmed working live. WS echo server superseded by the real M1 server. |
| M1 graph core | server half complete + review-hardened; frontend half complete on its track (canvas verified rendering) | S3 `track/server` commits `2c4a3ea`, `b4c75fe`, `55b20a8`, `222def3`, `1a77139`. `cd server && pnpm test` PASS (post-fix: 4 files / 20 tests incl. all 22 event-type fixtures, reducer cycle/readiness/critical-path/tombstone, idempotent double append, stale-base 409, digest ranking/bound, clone remapping, reporter auth, WS replay/live fan-out, SSE replay). `cd server && pnpm build` PASS. Adversarial review findings (5×P1, 2×P2) fixed in `bad4554` (project+actor-bound 15-min reporter credentials), `15043a3` (session-scoped policies + clone invalidation), `6c2131c` (clone anchored before clone time), `db0ad91` (handoff required before approval), `9a610e4` (split parents preserved as groups), `ef64fb6` (selection cleanup). Stack: Fastify 5.6.2, ws 8.18.3, node:sqlite. | The default `demo-seed` stream is empty until a real-run seed is imported (C5). Contract-consistent choices: SSE at `/sse` with WS query shape; replay strictly after `from_seq`; approval delay impact = longest remaining estimated path from the approval's node, older first on ties. |
| M2 tool layer | not started | — | — |
| M3 codex bridge | not started | — | — |
| M4 flight polish | not started | — | — |
| M5 rewire + contextual | not started | — | — |
| M6 seed + submission | not started | — | — |

Updated by the executing agent after every milestone (see AGENTS.md).

## M0 human browser verification (Chrome ✅ 2026-08-30 · ChatGPT browser ⏳ pre-submission requirement)

### ChatGPT built-in browser

1. After a human runs `vercel login` and deploys from `app/` with `npx vercel --yes`, open the resulting HTTPS URL in ChatGPT's built-in browser.
2. Confirm the yellow enable banner is absent. Record the displayed API namespace and dynamic-tools tier, plus the full user agent from the hello result.
3. Click **Get tools**. Confirm the raw result contains `hello_missiongraph`, its empty-object input schema, and `annotations.readOnlyHint: true`.
4. Click **Execute hello**. Confirm the raw return is a JSON string that parses to `{ok:true, ts, env:{ua, api}, cursor:"0", changes_since:[]}` and that `env.api` matches the displayed namespace.
5. In the ChatGPT conversation, ask the browser agent to call `hello_missiongraph`. Confirm it discovers the same tool and returns valid content. If discovery or execution differs from the in-page result, stop the M0 gate and record the exact error and observed API shape here.
6. Open the page console and record the `[MissionGraph] WebMCP namespace=...; dynamic-tools tier=...` line.

### Chrome 152.0.7977.64

1. Open `chrome://flags/#enable-webmcp-testing`, set **WebMCP testing** to **Enabled**, and relaunch Chrome.
2. From the repo, run `cd app && pnpm dev --host 127.0.0.1`, then open `http://127.0.0.1:5173/` in the relaunched Chrome 152.
3. Confirm the yellow enable banner is absent. Record the displayed API namespace and dynamic-tools tier; the expected pinned-notes path is `document` plus `provide-context`, but observed reality wins.
4. Click **Get tools** and verify `hello_missiongraph`, the empty-object schema, and `annotations.readOnlyHint: true` in the raw result.
5. Click **Execute hello** and verify the raw JSON string parses to `{ok:true, ts, env:{ua, api}, cursor:"0", changes_since:[]}` with `env.api` matching the displayed namespace.
6. In DevTools Console, confirm and record the `[MissionGraph] WebMCP namespace=...; dynamic-tools tier=...` line. Also note whether `executeTool` accepted the discovered tool object and JSON input string exactly as implemented.
7. Stop the dev server. If any API shape, return type, toolchange behavior, namespace, or tier differs from `docs/webmcp-notes.md`, stop the M0 gate and append the exact observed result here before any M1 work.
