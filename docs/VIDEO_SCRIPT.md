# Demo video script — 3:00, WebMCP first

The challenge is about WebMCP, so every beat is named by the WebMCP capability it proves, every beat carries a lower-third caption naming that primitive, and the narration says "WebMCP" where it matters. Thesis: the web page is the durable meeting place for people and agents who work at different times — it holds the state, the authority, and the record; the Codex fleet is today's tenant. Criteria mapping: **WebMCP Leverage** → beats 0, 1, 3 (native tool discovery, structured results with `cursor`/`changes_since`, contextual tools via `toolchange`); **Execution** → beat 2 (a WebMCP tool call becomes a real Codex worker, live) and beat 4 (the ledger); **Potential Impact** → the close; **Creativity & Ambition** → human-presence grants (agent proposes, page confirms) and mid-flight rewiring.

Recording frame: the whole ChatGPT desktop window — conversation (left) and the MissionGraph canvas in the built-in browser (right). The agent's tool-call entries must stay in frame; they are the proof. Record screen first, voice after. Every frame is live capture (C3); straight cuts only.

## Shot list

### 0. Cold open — the WebMCP handshake — 0:00–0:24
- **Screen**: ChatGPT's built-in browser opens https://missiongraph.vercel.app (mid-mission graph, critical path lit). The site-tools indicator is visible. Prompt: **"What tools does this page give you?"** The agent lists MissionGraph tools (graph_digest, list_ready, dispatch, split_task…).
- **Caption**: `document.modelContext · 25 tools registered by the page`
- **VO**: "Agents and people rarely work at the same time. Mine run while I'm away, and the page is the one thing that's always there. So I built mission control as a plain web page. Open it in ChatGPT's browser, and the page hands the agent twenty-five tools through WebMCP — nothing to install, no copy-paste. The browser agent just joined the crew."

### 1. Catch-up — tool calls and the digest — 0:24–0:52 (WebMCP Leverage)
- **Action**: **"Catch me up on this mission."** The agent calls `graph_digest`; the camera follows its narration across the nodes it names. Keep the tool-call entry in frame for at least two seconds.
- **Caption**: `graph_digest → { cursor, changes_since }`
- **VO**: "Watch the tool call. I ask to be caught up, and the agent reads the live graph through WebMCP — the real mission state, not scraped HTML. WebMCP is pull-only today — a page can't wake the agent — so every result carries a cursor and a bounded feed of what changed since. It comes back caught up, every time."

### 2. Policy, human presence, real worker — agent proposes, page confirms — 0:52–1:40 (Execution + security)
- **Action** (local stack, bridge running): **"My policy: approve anything under 50 changed lines with green tests."** → agent calls `state_policy` → the canvas shows the **Human policy confirmation** dialog (exact text + expiry) → click **Confirm** → agent clears the review queue under the grant. Then **"What's idle and worth staffing?"** → **"Dispatch it."** → second confirmation (action-scoped, one use) → Confirm → the node flips READY→RUNNING as a real Codex worker starts and its log scrolls.
- **Caption**: `human-presence grant · agent proposes → page confirms`
- **VO**: "Now the part that makes this safe. I state my approval policy in one sentence. The agent stages it through a WebMCP tool — but it can't approve anything by itself. The page shows me exactly what I'm granting; I confirm; every approval under that grant is logged with the policy behind it. Then: what's idle? Dispatch it. One more confirmation — and that WebMCP call becomes a real Codex worker, starting right now."

### 3. Contextual tools — the page talks back — 1:40–2:20 (WebMCP Leverage + Creativity)
- **Action**: click the **rate-limit task** (running on the local stack; paused in a fresh public clone). The agent's tool list gains the tools valid for that running selection (`split_selected`, `explain_selected`, `annotate_selected`; `dispatch_selected` appears only for a ready, unassigned selection); ask **"What new tools do you have now?"** if you want the agent to say it out loud. Then **"Split the rate-limit task into config and enforcement halves — show me the blast radius first."** → blast-radius preview (hold 2–3 s) → **"Apply it."** → confirm → children appear, edges re-route, critical path recomputes.
- **Caption**: `toolchange · contextual tools follow the selection`
- **VO**: "Now my favorite WebMCP moment. The moment I click a node, the page registers new tools for that selection — split it, explain it, annotate it — and the agent picks them up instantly. That's the page talking back through the tool list, the one channel WebMCP gives us today. I ask for a split; it shows the blast radius first; then it applies, and the graph rewires around work that's still running."
- **If the tool list does not visibly change on selection** (static-fallback runtime: all 5 contextual tools stay registered), record VO 3b instead and use the caption `contextual tools · scoped to the selected node`:
  **VO 3b**: "Now my favorite WebMCP moment. The page keeps a set of selection tools — split, explain, annotate — and the moment I click a node they apply to exactly that node. That's the page mirroring my context back to the agent through the tool list. I ask for a split; it shows the blast radius first; then it applies, and the graph rewires around work that's still running."
- **Do NOT claim a live re-brief.** A worker whose process is still `live` cannot be re-briefed (`resumeWorker` journals the request instead, bridge/src/actions.ts). Split children are supervision-only on the public fleet (unchanged seeded tasks only); say nothing that implies otherwise.

### 4. The record — 2:20–2:38 (Execution + Impact)
- **Screen**: open the dispatched node's dossier (Brief / Handoff / Decisions) → timeline replay → hold on the full graph.
- **Caption**: `audit ledger · who acted, under which grant`
- **VO**: "And everything consequential is on the record: what changed, who acted, and which grant authorized sensitive actions. Open any task and read its brief, its handoff, its decisions — then replay the whole mission."

### 5. Close — why WebMCP — 2:38–3:00 (Impact)
- **Screen**: full graph + URL, then the end card.
- **VO**: "That's why WebMCP. People and agents don't work at the same time, so the page becomes where they meet: it holds the state, the authority, and the record — and the agent in your browser gets hands on all of it. Today the crew is a Codex fleet; tomorrow, any long mission. missiongraph.vercel.app, inside ChatGPT's browser."
- **End card**: `missiongraph.vercel.app · 25 always-on + 5 contextual WebMCP tools · 323 tests · 19 fleet scenarios · adversarially reviewed`
  Measured 2026-09-02 after the fleet-eligibility fix: server 87 / bridge 109 / app 127 = **323**, plus the 19-scenario fleet contract stub. Re-run the suites on recording day rather than trusting this line.

VO total ≈ 359 words ≈ 2:28 of speech inside 3:00 — the rest is deliberately silent so the judges can read the tool calls.

## Pre-flight checklist (recording day)

1. ChatGPT app: model **GPT-5.6 Sol or Terra**; Settings → Browser → Permissions → **Enable site tools** ON.
2. Open https://missiongraph.vercel.app in the built-in browser: no yellow banner; ask the agent to list its MissionGraph tools (expect 25 core tools). Then select a node and ask again: if the list visibly gains the selection tools, beat 3 uses VO 3; if all 5 contextual tools were already listed (static fallback), use VO 3b — never narrate a change the frame does not show.
3. Local stack up for beats 2–3 (server + app + bridge; see SETUP.md); mission URL with project/token ready in a note to paste; dry-run one real dispatch before recording.
4. macOS Do Not Disturb on; browser pane zoomed (Cmd+) until node labels are legible at 1080p; window ≈16:9.
5. Record with QuickTime (or any screen recorder); one take per beat; retakes are cheap.

## Editing

Cut to ≤2:55 (the rule is 3:00; keep a margin for player timing). Straight cuts only; no stock footage, no still-screenshot montage. Add the five lower-third captions above verbatim (≥28 px equivalent, 3–4 s each). Voiceover or on-screen captions — either works; keep the VO lines above verbatim or tighter.
