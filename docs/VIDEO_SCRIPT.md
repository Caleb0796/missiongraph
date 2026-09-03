# Demo video script — 3:00, WebMCP first (v4: plain voice)

The challenge is about WebMCP, so every beat is named by the WebMCP capability it proves, every beat carries a lower-third caption naming that primitive, and every VO block says in plain words which WebMCP mechanism the frame is showing. Thesis: the web page is the durable meeting place for people and agents who work at different times; it holds the state, the authority, and the record; the Codex fleet is today's tenant. Criteria mapping: **WebMCP Leverage** → beats 0, 1, 3 (`document.modelContext.registerTool`, structured results with `cursor`/`changes_since`, contextual tools via `toolchange`); **Execution** → beat 2 (a WebMCP tool call becomes a real GPT-5.6 Sol Codex worker, live) and beat 4 (the ledger); **Potential Impact** → the close; **Creativity & Ambition** → human-presence grants (agent proposes, page confirms) and mid-flight rewiring.

Voice rules (v4): the narration is one engineer explaining their own tool to a colleague. Short sentences, first person, no dashes, no triads for effect, no taglines. Say the WebMCP mechanism by name where the frame shows it; never narrate a change the frame does not show.

Recording frame: the whole ChatGPT desktop window — conversation (left) and the MissionGraph canvas in the built-in browser (right). The agent's tool-call entries must stay in frame; they are the proof. Record screen first, voice after. Every frame is live capture (C3); straight cuts only.

## Shot list

### 0. Cold open — the WebMCP handshake — 0:00–0:24
- **Screen**: ChatGPT's built-in browser opens https://missiongraph.vercel.app (mid-mission graph, critical path lit). The site-tools indicator is visible. Prompt: **"What tools does this page give you?"** The agent lists MissionGraph tools (graph_digest, list_ready, dispatch, split_task…). Hold on the list.
- **Caption**: `document.modelContext.registerTool · 25 tools registered by the page`
- **VO 0** (64 words): "My agents work while I'm asleep. When I come back I need to know what happened and give the next orders, and the only thing that's always there is this web page. So the page is mission control. I open it in ChatGPT's browser, and it registers twenty-five tools with document.modelContext. Nothing to install. The agent just asks the page what it can do."

### 1. Catch-up — a tool call and its structured result — 0:24–0:50 (WebMCP Leverage)
- **Action**: **"Catch me up on this mission."** The agent calls `graph_digest`. Keep the tool-call entry in frame for at least two seconds; if the entry can be expanded, expand it so the result (`cursor`, `changes_since`) is readable for two seconds, then follow the agent's narration across the nodes it names.
- **Caption**: `graph_digest → { cursor, changes_since }`
- **VO 1** (56 words): "Watch the tool call. I ask what I missed, and the agent calls graph_digest through WebMCP. Not scraped HTML. A structured result with the actual mission state. A page can't wake an agent yet, so every result carries a cursor and the list of what changed since last time. The agent catches up on its own."

### 2. Policy, human presence, real worker — agent proposes, page confirms — 0:50–1:38 (Execution + security)
- **Action** (local stack, bridge running with `MG_CODEX_MODEL=gpt-5.6-sol`): **"My policy: approve anything under 50 changed lines with green tests."** → agent calls `state_policy` → the canvas shows the **Human policy confirmation** dialog (exact text + expiry) → click **Confirm** → agent clears the review queue under the grant. Then **"What's idle and worth staffing?"** → **"Dispatch it."** → second confirmation (action-scoped, one use) → Confirm → the node flips READY→RUNNING as a real Codex worker starts and its log scrolls.
- **Captions**: `human-presence grant · agent proposes → page confirms` on the dialog; `dispatch → real Codex worker · GPT-5.6 Sol via OpenAI API` on the READY→RUNNING flip.
- **VO 2** (84 words): "Here's the safety part. I type my approval policy in one sentence. The agent stages it through a WebMCP tool, but a tool call can't approve anything. The page asks me. I read what I'm granting and click confirm, and every approval under that policy is logged with the policy next to it. Then I ask what's idle and say dispatch it. One more confirm, and that tool call starts a real Codex worker, GPT-5.6 Sol on our fleet. You can watch it run."

### 3. Contextual tools — the page talks back through the tool list — 1:38–2:16 (WebMCP Leverage + Creativity)
- **Action**: click the **rate-limit task** (running on the local stack; paused in a fresh public clone). The agent's tool list gains the tools valid for that running selection (`split_selected`, `explain_selected`, `annotate_selected`; `dispatch_selected` appears only for a ready, unassigned selection). Ask **"What new tools do you have now?"** so the agent says the new tools out loud; that answer is the proof frame. Then **"Split the rate-limit task into config and enforcement halves — show me the blast radius first."** → blast-radius preview (hold 2–3 s) → **"Apply it."** → confirm → children appear, edges re-route, critical path recomputes.
- **Caption**: `toolchange · contextual tools follow the selection`
- **VO 3** (76 words): "This is the part I like most. I click a node, and the page registers new tools for that node: split, explain, annotate. The agent's tool list updates on its own. That tool list is the only channel a page has to talk back to the agent today, so I use it. I ask for a split. It shows me the blast radius first. I apply it, and the graph rewires while the work keeps running."
- **If the tool list does not visibly change on selection** (static-fallback runtime: all 5 contextual tools stay registered), record VO 3b instead and use the caption `contextual tools · scoped to the selected node`:
  **VO 3b** (75 words): "This is the part I like most. The page keeps a set of tools for the selected node: split, explain, annotate. I click a node, and they apply to exactly that node. That's the page handing my context to the agent through the tool list, the one channel it has today. I ask for a split. It shows me the blast radius first. I apply it, and the graph rewires while the work keeps running."
- **Do NOT claim a live re-brief.** A worker whose process is still `live` cannot be re-briefed (`resumeWorker` journals the request instead, bridge/src/actions.ts). Split children are supervision-only on the public fleet (unchanged seeded tasks only); say nothing that implies otherwise.

### 4. The record — 2:16–2:32 (Execution + Impact)
- **Screen**: open the dispatched node's dossier (Brief / Handoff / Decisions) → timeline replay → hold on the full graph.
- **Caption**: `audit ledger · who acted, under which grant`
- **VO 4** (38 words): "Everything that mattered is on the record. Every change the agent made through a WebMCP tool, who made it, and which grant allowed it. Open any task: the brief, the handoff, the decisions. Or replay the whole mission."

### 5. Close — 2:32–2:55 (Impact)
- **Screen**: full graph + URL, then the end card.
- **VO 5** (59 words): "People and agents don't work at the same time, so they meet on a page. WebMCP hands that page's state, permissions and record to the agent in your browser. The page runs no model of its own. The work is done by a Codex fleet on your own account, and the live site hosts one you can try. missiongraph.vercel.app."
- **End card**: `missiongraph.vercel.app · 25 always-on + 5 contextual WebMCP tools · live Codex fleet (GPT-5.6 Sol · OpenAI API) · 323 tests · 19 fleet scenarios · adversarially reviewed`
  Measured 2026-09-02 after the fleet-eligibility fix: server 87 / bridge 109 / app 127 = **323**, plus the 19-scenario fleet contract stub. Re-run the suites on recording day rather than trusting this line.

VO total ≈ 377 words ≈ 2:36 of speech inside 3:00; the rest is deliberately silent so the judges can read the tool calls.

## Claims the frame must back
- "GPT-5.6 Sol on our fleet" (VO 2) is true only if the local bridge runs with `MG_CODEX_MODEL=gpt-5.6-sol` (the laptop default; SETUP.md). The public Render fleet runs the same model at medium effort through an OpenAI API key (render.yaml).
- "on your own account" and "the live site hosts one you can try" (VO 5): the bridge spawns the local `codex` CLI (bridge/src/codex.ts) and therefore uses the login of the machine it runs on; the server makes no model calls. The public Render fleet is the hosted exception for judges: unchanged seeded tasks only, up to twenty accepted requests per UTC day, one per project (docs/SUBMISSION.md testing note).
- "registers twenty-five tools with document.modelContext" (VO 0): app/src/webmcp/registry.ts makes the literal `document.modelContext.registerTool` call; 25 always-on tools plus 5 contextual.
- Never say the page pushes or wakes the agent; page→agent is tool results and `toolchange` only.

## Pre-flight checklist (recording day)

1. ChatGPT app: model **GPT-5.6 Sol or Terra**; Settings → Browser → Permissions → **Enable site tools** ON.
2. Open https://missiongraph.vercel.app in the built-in browser: no yellow banner; ask the agent to list its MissionGraph tools (expect 25 core tools). Try expanding a tool-call entry once so you know whether beat 1 can show the result JSON. Then select a node and ask again: if the list visibly gains the selection tools, beat 3 uses VO 3; if all 5 contextual tools were already listed (static fallback), use VO 3b — never narrate a change the frame does not show.
3. Local stack up for beats 2–3 (server + app + bridge with `MG_CODEX_MODEL=gpt-5.6-sol`; see SETUP.md); mission URL with project/token ready in a note to paste; dry-run one real dispatch before recording.
4. macOS Do Not Disturb on; browser pane zoomed (Cmd+) until node labels are legible at 1080p; window ≈16:9.
5. Record with QuickTime (or any screen recorder); one take per beat; retakes are cheap.

## Editing

Cut to ≤2:55 (the rule is 3:00; keep a margin for player timing). Straight cuts only; no stock footage, no still-screenshot montage. Add the six lower-third captions above verbatim (≥28 px equivalent, 3–4 s each). Voiceover or on-screen captions — either works; keep the VO lines above verbatim or tighter. Read them like you are explaining the tool to a colleague, not presenting it.
