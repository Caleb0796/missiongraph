# Demo video script — 3:00, WebMCP first

The challenge is about WebMCP, so every beat is named by the WebMCP capability it proves, every beat carries a lower-third caption naming that primitive, and the narration says "WebMCP" where it matters. Criteria mapping: **WebMCP Leverage** → beats 0, 1, 3 (native tool discovery, structured results with `cursor`/`changes_since`, contextual tools via `toolchange`); **Execution** → beat 2 (a WebMCP tool call becomes a real Codex worker, live) and beat 4 (the ledger); **Potential Impact** → the close; **Creativity & Ambition** → human-presence grants (agent proposes, page confirms) and mid-flight rewiring.

Recording frame: the whole ChatGPT desktop window — conversation (left) and the MissionGraph canvas in the built-in browser (right). The agent's tool-call entries must stay in frame; they are the proof. Record screen first, voice after. Every frame is live capture (C3); straight cuts only.

## Shot list

### 0. Cold open — the WebMCP handshake — 0:00–0:20
- **Screen**: ChatGPT's built-in browser opens https://missiongraph.vercel.app (mid-mission graph, critical path lit). The site-tools indicator is visible. Prompt: **"What tools does this page give you?"** The agent lists MissionGraph tools (graph_digest, list_ready, dispatch, split_task…).
- **Caption**: `document.modelContext · 25 tools registered by the page`
- **VO**: "This looks like an ordinary web page. Open it inside ChatGPT's browser, and the page hands the agent twenty-five tools through WebMCP — nothing to install, no API keys, no copy-paste. MissionGraph is mission control for a fleet of coding agents, and the browser agent just joined the crew."

### 1. Catch-up — tool calls and the digest — 0:20–0:50 (WebMCP Leverage)
- **Action**: **"Catch me up on this mission."** The agent calls `graph_digest`; the camera follows its narration across the nodes it names. Keep the tool-call entry in frame for at least two seconds.
- **Caption**: `graph_digest → { cursor, changes_since }`
- **VO**: "Watch the tool call. I ask to be caught up, and the agent reads the live graph through WebMCP — not a screenshot, not scraped HTML, the real mission state. And because WebMCP is pull-only today — a page can't wake the agent — every result carries a cursor and a bounded feed of what changed since the last cursor. The agent never works from a stale picture."

### 2. Policy, human presence, real worker — agent proposes, page confirms — 0:50–1:40 (Execution + security)
- **Action** (local stack, bridge running): **"My policy: approve anything under 50 changed lines with green tests."** → agent calls `state_policy` → the canvas shows the **Human policy confirmation** dialog (exact text + expiry) → click **Confirm** → agent clears the review queue under the grant. Then **"What's idle and worth staffing?"** → **"Dispatch it."** → second confirmation (action-scoped, one use) → Confirm → the node flips READY→RUNNING as a real Codex worker starts and its log scrolls.
- **Caption**: `human-presence grant · agent proposes → page confirms → ledger records`
- **VO**: "Now the part that makes this safe. I state my approval policy in one sentence. The agent stages it through a WebMCP tool — but it can't approve anything by itself. The page shows me exactly what I'm granting, and I confirm. That click mints a grant, and every approval under it is logged with the policy behind it. Then I ask what's idle, say dispatch, confirm once more — and that WebMCP call becomes a real Codex worker, starting right now."

### 3. Contextual tools — the page talks back — 1:40–2:20 (WebMCP Leverage + Creativity)
- **Action**: click the **rate-limit task** (running on the local stack; paused in a fresh public clone). The agent's tool list gains the tools valid for that running selection (`split_selected`, `explain_selected`, `annotate_selected`; `dispatch_selected` appears only for a ready, unassigned selection); ask **"What new tools do you have now?"** if you want the agent to say it out loud. Then **"Split the rate-limit task into config and enforcement halves — show me the blast radius first."** → blast-radius preview (hold 2–3 s) → **"Apply it."** → confirm → children appear, edges re-route, critical path recomputes.
- **Caption**: `toolchange · 5 contextual tools follow selection + failure state`
- **VO**: "Here's the WebMCP feature I want you to see. The moment I click a node, the page registers new tools for that selection — split it, explain it, annotate it — and the agent picks them up instantly. That's the page talking back through the tool list, the one channel WebMCP gives us today. I ask for a split, it shows the blast radius first, then applies it, and the graph rewires around work that's still running."
- **Do NOT claim a live re-brief.** A worker whose process is still `live` cannot be re-briefed (`resumeWorker` journals the request instead, bridge/src/actions.ts). Split children are supervision-only on the public fleet (unchanged seeded tasks only); say nothing that implies otherwise.

### 4. The record — 2:20–2:40 (Execution + Impact)
- **Screen**: open the dispatched node's dossier (Brief / Handoff / Decisions) → timeline replay → hold on the full graph.
- **Caption**: `audit ledger · capability ref + use nonce on every grant-authorized event`
- **VO**: "And everything consequential is on the record: what changed, who acted, and which grant authorized sensitive actions. Open any task and read its brief, its handoff, its decisions — then replay the whole mission."

### 5. Close — why WebMCP — 2:40–3:00 (Impact)
- **Screen**: full graph + URL, then the end card.
- **VO**: "That's why WebMCP: the agent already in your browser gets hands on live state that DOM scraping could never reach, and the page mirrors your context back. Human, browser agent, worker fleet — each doing what only they can. Code today; any long mission tomorrow. missiongraph.vercel.app, inside ChatGPT's browser."
- **End card**: `missiongraph.vercel.app · 25 always-on + 5 contextual WebMCP tools · 323 tests · 19 fleet scenarios · adversarially reviewed`
  Measured 2026-09-02 after the fleet-eligibility fix: server 87 / bridge 109 / app 127 = **323**, plus the 19-scenario fleet contract stub. Re-run the suites on recording day rather than trusting this line.

VO total ≈ 359 words ≈ 2:29 of speech inside 3:00 — the rest is deliberately silent so the judges can read the tool calls.

## Pre-flight checklist (recording day)

1. ChatGPT app: model **GPT-5.6 Sol or Terra**; Settings → Browser → Permissions → **Enable site tools** ON.
2. Open https://missiongraph.vercel.app in the built-in browser: no yellow banner; ask the agent to list its MissionGraph tools (expect 25 core tools; applicable contextual tools follow selection and failure state — the static fallback may list all 5).
3. Local stack up for beats 2–3 (server + app + bridge; see SETUP.md); mission URL with project/token ready in a note to paste; dry-run one real dispatch before recording.
4. macOS Do Not Disturb on; browser pane zoomed (Cmd+) until node labels are legible at 1080p; window ≈16:9.
5. Record with QuickTime (or any screen recorder); one take per beat; retakes are cheap.

## Editing

Cut to ≤3:00. Straight cuts only; no stock footage, no still-screenshot montage. Add the five lower-third captions above verbatim (≥28 px equivalent, 3–4 s each). Voiceover or on-screen captions — either works; keep the VO lines above verbatim or tighter.
