# Demo video script — 3:00, judged against the four 25% criteria

Criteria mapping: **WebMCP Leverage** → every beat shows the agent discovering/calling tools natively; **Execution** → all footage is live capture of the real stack (no mockups, no staged screenshots); **Potential Impact** → open and close narration; **Creativity & Ambition** → human-presence authorization + mid-flight graph re-engineering.

Recording frame: the whole ChatGPT desktop window — agent conversation (left pane) and the MissionGraph canvas in the built-in browser (right pane). Human, browser agent, and worker fleet share one frame. Record screen first, add voiceover (or captions) after. Segments may be recorded separately and cut together; every frame is live footage (C3).

## Shot list

### 0. Hook — 0:00–0:20
- **Screen**: ChatGPT built-in browser on https://missiongraph.vercel.app, mid-mission graph (done/running/review mixed, critical path lit). Slow pan.
- **VO**: "Parallel agent fleets are fast — and illegible. Chat is legible — and serial. MissionGraph is mission control: one living task graph where you, your browser agent, and a fleet of Codex workers run a project together."

### 1. Agent catch-up — 0:20–1:00 (WebMCP Leverage)
- **Action**: click a first-run chip to copy the prompt; tell the agent **"Catch me up on this mission."** Agent calls `graph_digest`; the camera lens follows its narration.
- **VO**: "The page registers 20-plus tools on document.modelContext. My agent discovers them natively — no extension, no copy-paste. Every tool result carries a cursor and everything that changed since, so an agent that was away five minutes is current by its next call."
- **Must be in frame**: the agent's tool-call entries in the conversation pane.

### 2. Policy grant + live fleet — 1:00–1:55 (Execution + security)
- **Action**: on the local-stack mission (bridge running): say **"My policy: approve anything under 50 changed lines with green tests."** → agent calls `state_policy` → the canvas shows the **Human policy confirmation** dialog (exact text + expiry) → human clicks **Confirm** → agent clears the review queue under the grant. Then **"What's idle and worth staffing?"** → **"Dispatch it."** → a second confirmation dialog (action-scoped, one use) → Confirm → node flips READY→RUNNING as a real Codex worker starts.
- **VO**: "I state a policy in one sentence. The agent cannot self-authorize — a visible human confirmation mints the grant, then the agent clears the queue under it; every approval records the policy it cited and consumes a nonce-bound use. The idle radar finds unstaffed work; one dispatch, and a real Codex worker picks it up — live."

### 3. Mid-flight rewire — 1:55–2:35 (Creativity & Ambition)
- **Action**: select the **running rate-limit task** (contextual tools register on selection) → **"Split the rate-limit task into config and enforcement halves — show me the blast radius first."** → blast-radius preview → **"Apply it."** → confirm → edges re-route, critical path recomputes, workers get re-briefed.
- **VO**: "Mid-flight, I re-engineer the graph itself. Selecting a node registers contextual tools on the fly. A split previews its blast radius before anything applies — then workers are re-briefed and the critical path re-routes, live."

### 4. Close — 2:35–3:00 (Impact)
- **Screen**: open a node dossier (Brief / Handoff / Decisions) → timeline replay → hold on full graph + URL.
- **VO**: "Everything you saw is one append-only ledger — every actor labeled, every decision auditable. The mission judges explore is a real run: real workers, real commits, real approvals. Supervision-by-exception for agent fleets — missiongraph.vercel.app, native in ChatGPT's browser."
- **End card**: `missiongraph.vercel.app · 156 tests · CI · adversarially reviewed`

## Pre-flight checklist (recording day)

1. ChatGPT app: model **GPT-5.6 Sol or Terra**; Settings → Browser → Permissions → **Enable site tools** ON.
2. Open https://missiongraph.vercel.app in the built-in browser: no yellow banner; ask the agent to list its MissionGraph tools (expect 20+).
3. Local stack up for beats 2–3 (server + app + bridge; see SETUP.md); mission URL with project/token ready in a note to paste.
4. macOS Do Not Disturb on; browser pane zoomed (Cmd+) until node labels are legible at 1080p; window ≈16:9.
5. Record with QuickTime (or any screen recorder); one take per beat; retakes are cheap.

## Editing

Cut to ≤3:00. Straight cuts only; no stock footage, no still-screenshot montage. Voiceover or on-screen captions — either works; keep the VO lines above verbatim or tighter.
