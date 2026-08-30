# PROGRESS

| Milestone | Status | Evidence | Deviations |
|---|---|---|---|
| M0 scaffold + compat spike | frontend half complete; browser compat gate and deploy pending [HUMAN] | S1 `track/frontend` commit `b7468f6`. Scaffold: `pnpm create vite app --template react-ts`; dependencies: `pnpm install`, `pnpm add -D tailwindcss @tailwindcss/vite` (Tailwind 4.3.3). `cd app && pnpm build` PASS (`tsc -b && vite build`, Vite 8.2.2, 17 modules); `pnpm lint` PASS (oxlint 1.80.0); `pnpm dev --host 127.0.0.1` served `http://127.0.0.1:5173/`; `curl --fail --silent --show-error http://127.0.0.1:5173/` PASS and returned HTML titled `MissionGraph WebMCP Compatibility`. Runtime WebMCP namespace/tier were not observed by curl because it does not execute page JavaScript; exact target-browser checks are below. Environment versions from the trusted 2026-08-30 probe: Node 22.23.1, pnpm 9.15.9, Chrome 152.0.7977.64. `npx vercel whoami` hit the sandboxed npm cache; non-interactive retry `npx --yes vercel whoami` ran Vercel CLI 59.10.0 and returned `Logged out.` | Deploy skipped: **blocked on human: vercel login**; no login flow attempted. ChatGPT browser and flagged Chrome 152 results are pending, so M0's hard compat gate has not passed. The current official Chrome imperative API page shows `executeTool(discoveredTool, jsonInputString)` while `docs/webmcp-notes.md` abbreviates the first argument as a name; the self-test uses the discovered tool object. This is a docs-level discrepancy pending target-browser confirmation. WS echo server is outside S1's frontend half. |
| M1 graph core | frontend half implemented; automated visual browser check blocked by environment | S1b `track/frontend` commit `534bd08`. Added the CONTRACTS §1–§2 event/domain types; a 14-node Shorty fixture with 3 dependency edges, 15 deduplicated conflict edges, 47 contract-shaped fixture events, four approvals, and a mid-flight 3 done / 2 running / 1 failed / 4 review / 4 queued state; event-folded zustand actions; deterministic 45-minute remaining critical path; elkjs left-to-right React Flow canvas; node/edge dossier; pulse, catch-up, and timeline camera controls; cycle rejection and tombstone deletion; `/compat` preserving `hello_missiongraph`. Added `@xyflow/react` 12.11.5, `elkjs` 0.12.0, and `zustand` 5.0.15. `cd app && pnpm lint` PASS (oxlint 1.80.0). `cd app && pnpm build` PASS (`tsc -b && vite build`, Vite 8.2.2, 185 modules, 297 ms); Vite emitted a non-failing >500 kB chunk warning for the elk browser bundle. `pnpm dev --host 127.0.0.1` served `http://127.0.0.1:5174/` because 5173 was already occupied; curl PASS for `/` and `/compat`, both returning HTML titled `MissionGraph`. `git diff --check` PASS; changed-scope secret scan found no matches. | The kickoff explicitly directed this frontend-only M1 continuation while M0's human browser gate remains pending; no M2 tools were added. Playwright visual verification could not start: `EPERM: operation not permitted, mkdir '/Users/calebwei/Library/Caches/ms-playwright/daemon/…'`; its escalation was rejected. The in-app Browser fallback reported `No browser is available` and an empty browser list, so selection, camera, drag/connect/delete, and screenshot checks remain unverified in a rendered browser. Curl does not execute JavaScript. Fixture records are clearly labeled `fixture simulation` and are not a C5 real-run seed. No SHORTY/CONTRACTS conflict was found: conflict pairs were deduplicated, and the two pairs that are both prerequisites and advisory conflicts remain separate edge kinds as CONTRACTS permits. |
| M2 tool layer | not started | — | — |
| M3 codex bridge | not started | — | — |
| M4 flight polish | not started | — | — |
| M5 rewire + contextual | not started | — | — |
| M6 seed + submission | not started | — | — |

Updated by the executing agent after every milestone (see AGENTS.md).

## M0 human browser verification (pending)

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
