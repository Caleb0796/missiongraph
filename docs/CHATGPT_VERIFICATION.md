# ChatGPT built-in browser verification (C6 — required before submission)

**操作方法（human）**：把下面 "TASK FOR CHATGPT" 整段粘贴进 ChatGPT app（开启其内置浏览器/agent 模式的对话），等它执行完输出报告，把报告原样带回给编排者判定。若它在第 A2 步就发现不了 WebMCP（连 namespace 都没有），立即停下回报——那是红灯级问题。

安全性说明：页面首次访问会自动克隆一个访客私有副本，agent 的任何写操作只影响它自己的副本，不触碰种子或他人数据。

若 agent 报 `ENVIRONMENT NOT READY`（尤其是 Enable site tools）：这是 app 侧门禁，不是应用缺陷，且 agent 通常打不开自己的设置页——需要人手动核对四项后重跑：① app 升到最新版；② 对话模型选 GPT-5.6 Sol 或 Terra（Luna 关闭了 WebMCP）；③ Settings → Browser → Permissions → Enable site tools 打开；④ 个人（非 Enterprise/Edu）工作区。重跑途中若出现 "model is at capacity" 换模型提示，确保仍停留在 Sol/Terra，否则 WebMCP 会静默失效。

---

## TASK FOR CHATGPT (paste everything below this line)

You are verifying a WebMCP-enabled web application called **MissionGraph** using your built-in browser. The page registers tools on `document.modelContext` (WebMCP). Your first visit auto-clones a private sandbox copy of a mission, so any write operations you perform are safe and affect only your copy. Work through Acts 0 and A–C in order and produce the report in Act C exactly in the given format. Where a step says "paste raw", include the verbatim text/JSON you received, untruncated where reasonable.

### Act 0 — environment gate (do this FIRST)

Per OpenAI's site-tools documentation (learn.chatgpt.com/docs/webmcp), WebMCP in the ChatGPT/Codex desktop app's built-in browser requires ALL of: (a) the latest app version, (b) the conversation model set to **GPT-5.6 Sol or Terra** — **Luna has WebMCP disabled**, (c) **Settings > Browser > Permissions > "Enable site tools" turned ON**, (d) not an Enterprise/Edu workspace. Report which model you are running as and whether site tools are enabled. If any requirement is unmet, STOP and report only: `ENVIRONMENT NOT READY: <which requirement>`.

### Act A′ — official Site tools panel (authoritative check)

After opening `https://missiongraph.vercel.app/` in your browser, click **Site tools** in the browser's address bar. Report exactly what it shows: the tool count and read/write split (e.g. "3 read, 7 write tools"), and the first ten tool names listed under **Available site tools**. This panel is OpenAI's own verification surface and outranks the page's self-test.

### Act A — compatibility page self-test

1. Open `https://missiongraph.vercel.app/compat` in your browser.
2. Report: (a) is there a yellow "enable WebMCP" banner? (b) the displayed **API namespace** value, (c) the displayed **dynamic-tools tier** value (`abort-controller`, `provide-context`, or `none`), (d) your user agent as shown on the page if displayed. `none` means the runtime is using the always-registered static fallback: if hello still works in steps 3–4, record it as a yellow flag rather than a red failure.
3. Click the **Get tools** button on the page. Paste raw: does the result contain a tool named `hello_missiongraph`, an empty-object input schema, and `annotations.readOnlyHint: true`?
4. Click the **Execute hello** button. Paste the raw returned string. Confirm it is a JSON **string** that parses to an object with `ok: true`, a `ts` field, `env.ua`, `env.api`, `cursor`, and `changes_since`, and that `env.api` matches the namespace from step 2.

### Act B — your own tool access (the real test)

5. Open `https://missiongraph.vercel.app/` and wait for the mission canvas to load (it should show a LIVE indicator and a task graph, not an "enable WebMCP" banner).
6. List the MissionGraph tools **you yourself can discover** through your WebMCP integration — tool names only, plus the total count.
7. Call `graph_digest` (no arguments or `{}`). Report: two-sentence summary of what this mission is about based on the returned narrative, and the exact `cursor` value.
8. Call `list_ready`. Report which tasks it says are ready to start.
9. Call `state_policy` with `{"text": "Approve changes under 50 lines with green tests during this verification session."}` (adapt only if the discovered schema differs). The expected tool response is `ok:true` with `data.status:"pending_human_confirmation"`, a `draft_id`, `allowed_actions`, `max_uses`, and `expires_at`; it must **not** contain a `policy_ref` or raw capability, and its cursor may remain unchanged because staging appends no event. Report those fields and ask the human to inspect the visible **Human policy confirmation** dialog on the MissionGraph canvas (exact policy text/hash, project, session, approve/reject actions, use limit, and expiry), then click **Confirm**. Wait for the human to say confirmation finished. Call `graph_digest` with `{"since":"<the cursor returned by state_policy>"}`, find the resulting `POLICY_STATED` event, and report its `policy_ref` plus the new cursor. If the dialog is absent, denied, expired, or confirmation does not produce `POLICY_STATED`, report B9 as failed and stop before approval.
10. Call `list_pending_approvals`, choose one pending approval, then call `approve` with its `id`, the confirmed `policy_ref` from step 9, and a short verification rationale. Report the approval tool's `ok`, `approval_id`, and new cursor. In that result's `changes_since`, confirm the `APPROVED` event has `authorization.capability_ref` equal to the policy ref and a non-empty `authorization.use_nonce`; report those values, but do not expect or expose the raw capability token. This verifies that the confirmed multi-use policy grant consumed one nonce-bound use without another confirmation dialog.
11. Call `graph_digest` again with `{"since": "<the cursor you saw in step 7>"}`. If B10 approved an item, confirm both the human-attributed `POLICY_STATED` event and the browser-agent `APPROVED` event appear in `changes_since`, including the approval's capability reference and use nonce. If B10 was `skipped-no-pending`, check and report only the `POLICY_STATED` event; the absent `APPROVED` event is not a B11 failure in that case.
12. OPTIONAL (only if steps 6–11 all succeeded): call `split_task` on any QUEUED task with two subtasks per its schema, WITHOUT `confirm`. Report whether you received a `preview` containing `op_token` and `blast_radius`. Then STOP — do NOT send the confirm call.

### Act C — report (fill exactly)

```
MISSIONGRAPH VERIFICATION REPORT
Environment: <ChatGPT app version/platform if known>
A2 banner-absent: <yes/no>   namespace: <...>   tier: <...>
A3 hello tool present: <yes/no>  readOnlyHint: <yes/no>
A4 hello executes: <yes/no>  env.api matches: <yes/no>
   raw hello result: <paste>
B6 tools discovered by agent: <count>
   names: <list>
B7 graph_digest: <ok/fail>  cursor: <...>
   mission summary: <2 sentences>
B8 list_ready: <ok/fail>  ready tasks: <...>
B9 state_policy staged: <ok/fail>  draft_id: <...>  cursor: <...>
   no policy_ref/capability in tool response: <yes/no>
   human confirmation: <confirmed/denied/absent/expired>  policy_ref from POLICY_STATED: <...>  cursor after confirmation: <...>
B10 policy-backed approve: <ok/fail/skipped-no-pending>  approval_id: <...>  cursor: <...>
   capability_ref matches policy_ref: <yes/no>  use_nonce present: <yes/no>
B11 own events visible in changes_since: <yes/no>
B12 split preview (optional): <received op_token+blast_radius / skipped / fail>
ERRORS (verbatim, any step): <none / paste>
```

---

## 判定标准（orchestrator use）

| 项 | PASS 条件 |
|---|---|
| A2 | 无 enable 横幅；namespace ∈ {document, navigator}（记录实际值）；tier ∈ {abort-controller, provide-context}。若 tier 为 `none` 但 A3/A4 hello 正常，记黄灯并继续（静态 fallback 可用），不是红灯；其他值失败 |
| A3/A4 | hello 在列，readOnlyHint true；返回为可解析 JSON 字符串，`ok:true` 且 `env.api` 与 namespace 一致 |
| B6 | agent 侧发现 ≥ 20 个工具（全量 24；上下文工具依选中状态注册，允许缺席） |
| B7/B8 | 每次调用 `ok:true`；只读调用允许 cursor 不变 |
| B9 | `state_policy` 返回 `ok:true` + `pending_human_confirmation` + `draft_id`，不泄露 `policy_ref`/capability；人类在可见 UI 中核对并确认后才出现 human-attributed `POLICY_STATED`，agent 从该事件取得 `policy_ref`，cursor 才前进 |
| B10 | `approve` 返回 `ok:true`，无需第二次弹窗；对应 `APPROVED` 事件的 `authorization.capability_ref` 匹配已确认 policy，且有非空唯一 `use_nonce`（原始 capability 不出现在工具结果/事件中）。若确实无 pending approval，标记 `skipped-no-pending` 并原样报告，不伪造 PASS |
| B11 | B10 成功时，步骤 9 的 `POLICY_STATED` 与步骤 10 的 `APPROVED` 均出现在 `changes_since`；B10 为 `skipped-no-pending` 时，仅要求 `POLICY_STATED` 出现（数字游标补课闭环成立） |
| B12（加分） | 收到 `preview.op_token` + `blast_radius` 且未确认（两步协议在真 agent 手上成立） |

任一 A 项失败或 B6/B7 失败 = C6 红灯，停止提交流程回报编排者。B8–B12 个别失败 = 黄灯，带原始错误回报判定。验证通过后：结果记入 PROGRESS.md 的 M0 ChatGPT 行并提交。
