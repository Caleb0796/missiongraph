# Video shooting script (<3:00, real capture only — C3)

**Rules**: every frame is a real screen recording (no mockups, no still-image montage). Timelapses are allowed but must be labeled on screen ("timelapse"). Record 1080p+, voiceover in one take or spliced — but narration must describe what is actually happening on screen.

**Setup before recording**: fresh Chrome profile with the WebMCP flag ON (or ChatGPT built-in browser), production URL loaded once so the clone exists; bridge + VM fleet alive; one throwaway mission cloned for the S1 segment; the real-run seeded mission open for S2/S3.

| Time | Scene | Screen actions | Voiceover (draft) |
|---|---|---|---|
| 0:00–0:20 | Problem | Split screen: left = a linear chat loop crawling through a todo list; right = a terminal with parallel agent logs scrolling illegibly. | "Parallel agents are fast — and illegible. A chat loop is legible — and slow. You shouldn't have to choose." |
| 0:20–1:00 | S1 Genesis | Type a one-paragraph mission into ChatGPT; agent calls `plan_seed`; DAG blooms on canvas, critical path ignites gold. Human drags one node; agent splits an oversized node (preview → confirm). | "Describe the mission once. Your browser agent — through WebMCP — plans it as a living dependency graph. You drag; it splits. The critical path lights up by itself." |
| 1:00–2:00 | S2 Flight | Real workers running (running rings on nodes). Label "timelapse" while workers progress. Ask agent: "catch me up" → digest narration. State policy: "approve anything under 50 lines with green tests" → agent clears the queue (policy chips visible on timeline). Idle radar → one-click dispatch. One node flips green in real time. | "Real Codex workers execute in parallel. Ask your agent to catch you up — every tool call carries the change stream. State a policy in one sentence; the agent approves under it, and every approval records which policy authorized it. The radar finds idle work; staffing it is one click." |
| 2:00–2:40 | S3 Rewire | Split a RUNNING task: blast radius flashes (stale/pausing nodes highlighted); confirm; workers re-brief (timeline shows rebrief); critical path re-routes. | "Plans change mid-flight. Split a running task — MissionGraph previews the blast radius before anything applies. Workers are re-briefed, the path re-routes, and the audit trail keeps every why." |
| 2:40–3:00 | Close | Dossier open on a done node (handoff prose). Zoom out to full graph. Card: repo + URL. | "Your agent supervises the fleet. You supervise by exception. The web page is the shared mission control. MissionGraph — built on WebMCP." |

**Capture checklist**: cursor visible; browser zoom 100%; hide bookmarks bar; timeline strip visible in S2/S3; do NOT show tokens in the URL bar (use the clone flow, not a capability link); one full dry run before recording.
