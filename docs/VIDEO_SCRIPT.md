# Demo video script — 3:00, judged against the four 25% criteria

Criteria mapping: **WebMCP Leverage** → every beat shows the agent discovering/calling tools natively; **Execution** → all footage is live capture of the real stack (no mockups, no staged screenshots); **Potential Impact** → open and close narration; **Creativity & Ambition** → human-presence authorization + mid-flight graph re-engineering.

Recording frame: the whole ChatGPT desktop window — agent conversation (left pane) and the MissionGraph canvas in the built-in browser (right pane). Human, browser agent, and worker fleet share one frame. Record screen first, add voiceover (or captions) after. Segments may be recorded separately and cut together; every frame is live footage (C3).

## Shot list

### 0. Hook — 0:00–0:20
- **Screen**: ChatGPT built-in browser on https://missiongraph.vercel.app, mid-mission graph (done/running/review mixed, critical path lit). Slow pan.
- **VO**: "I run coding agents in parallel — and honestly, I lose track. Chat can only tell me one thread at a time. This is MissionGraph: the whole mission on one live graph — me, my browser agent, and real Codex workers, all looking at the same picture."

### 1. Agent catch-up — 0:20–1:00 (WebMCP Leverage)
- **Action**: click a first-run chip to copy the prompt; tell the agent **"Catch me up on this mission."** Agent calls `graph_digest`; the camera lens follows its narration.
- **VO**: "Watch this — I just ask my agent to catch me up. The page has already handed it twenty-five always-on tools through WebMCP and can add any of five contextual tools as they become relevant — no extension, no copy-paste. And every answer comes with whatever changed while it was away, so it's never working from a stale picture."
- **Must be in frame**: the agent's tool-call entries in the conversation pane.

### 2. Policy grant + live fleet — 1:00–1:55 (Execution + security)
- **Action**: on the local-stack mission (bridge running): say **"My policy: approve anything under 50 changed lines with green tests."** → agent calls `state_policy` → the canvas shows the **Human policy confirmation** dialog (exact text + expiry) → human clicks **Confirm** → agent clears the review queue under the grant. Then **"What's idle and worth staffing?"** → **"Dispatch it."** → a second confirmation dialog (action-scoped, one use) → Confirm → node flips READY→RUNNING as a real Codex worker starts.
- **VO**: "Now the security part. I give it my policy in one sentence. But the agent can't just approve things on its own — I get this dialog, I read exactly what I'm signing off on, and I click confirm. Then it clears the review queue, and every single approval is logged with the policy behind it. Next: I ask what's sitting idle, tell it to dispatch — one more confirmation — and that's a real Codex worker starting up. Live."

### 3. Mid-flight rewire — 1:55–2:35 (Creativity & Ambition)
- **Action**: select the **running rate-limit task** (contextual tools register on selection) → **"Split the rate-limit task into config and enforcement halves — show me the blast radius first."** → stale/pausing-work blast-radius preview → **"Apply it."** → confirm → the split is recorded, the parent's children appear, edges re-route, and the critical path recomputes.
- **VO**: "Here's my favorite part. That rate-limit task is already running — and I can still redesign around it. The moment I click the node, the page hands my agent new tools just for it. I ask for a split, it shows me the blast radius first — what this touches — then I apply, and the graph rewires itself. Watch the critical path move."
- **Do NOT claim a live re-brief.** A worker whose process is still `live` cannot be re-briefed: `resumeWorker` rejects `rebrief_worker` for a live process and journals it instead (bridge/src/actions.ts). The running worker keeps its original brief until it exits; the supervisor can then re-brief the idle thread.

### 4. Close — 2:35–3:00 (Impact)
- **Screen**: open a node dossier (Brief / Handoff / Decisions) → timeline replay → hold on full graph + URL.
- **VO**: "And everything you just watched is on the record — every action, who did it, under what authority. The mission you can explore yourself is a real run: real workers, real commits, real approvals. Code today — but this works for any long-running mission. missiongraph.vercel.app, right inside ChatGPT's browser."
- **End card**: `missiongraph.vercel.app · 251 tests · 19 fleet scenarios · live-fire arbitration · adversarially reviewed`
  Measured 2026-09-01 on merged main (`cf9cdbf`): server 69 / bridge 77 / app 105 = **251**, plus the 19-scenario fleet contract stub and a real-codex arbitration PASS (sol/medium, full lifecycle + handoff + approval). Re-run the suites on recording day rather than trusting this line.

## Pre-flight checklist (recording day)

1. ChatGPT app: model **GPT-5.6 Sol or Terra**; Settings → Browser → Permissions → **Enable site tools** ON.
2. Open https://missiongraph.vercel.app in the built-in browser: no yellow banner; ask the agent to list its MissionGraph tools (expect 25 always-on, with applicable tools drawn from a 5-tool contextual set).
3. Local stack up for beats 2–3 (server + app + bridge; see SETUP.md); mission URL with project/token ready in a note to paste.
4. macOS Do Not Disturb on; browser pane zoomed (Cmd+) until node labels are legible at 1080p; window ≈16:9.
5. Record with QuickTime (or any screen recorder); one take per beat; retakes are cheap.

## Editing

Cut to ≤3:00. Straight cuts only; no stock footage, no still-screenshot montage. Voiceover or on-screen captions — either works; keep the VO lines above verbatim or tighter.
