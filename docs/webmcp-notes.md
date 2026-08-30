# WebMCP API — pinned facts (verified against Chrome docs, 2026-08-30)

Source: developer.chrome.com/docs/ai/webmcp (+ /imperative-api), github.com/webmachinelearning/webmcp.
These are the M0 starting assumptions; the LIVE API observed during M0 is final authority.

## Canonical registration (imperative API)

```js
document.modelContext.registerTool({
  name: "tool_name",
  description: "One clear sentence. Agents choose tools by this.",
  inputSchema: { type: "object", properties: { x: { type: "string" } }, required: [] },
  annotations: { readOnlyHint: true },          // set on all read-only tools
  async execute(inputs, { signal }) {           // signal = AbortSignal for cancellation
    return JSON.stringify({ ok: true });        // tools return plain STRINGS
  }
});
```

- Namespace: `document.modelContext` (current); `navigator.modelContext` was the older location (deprecated Chrome 150) — feature-detect both, prefer document.
- **Return contract: a string.** No MCP `{content:[...]}` wrapper. We return JSON strings carrying `{...data, cursor, changes_since}`.
- Unregister: `registerTool(tool, { signal: abortController.signal })` then `controller.abort()` — **Chrome 153+**. This is what dynamic contextual tools ride on.
- Discovery/self-test (no agent needed): `document.modelContext.getTools()` and `executeTool(name, jsonInputString)` — use these for the M0 in-page smoke test.
- `document.modelContext.addEventListener("toolchange", cb)` fires when the tool list changes.
- Cross-origin iframes need `allow="tools"`; Permissions Policy `tools` defaults to `self`; page must keep origin isolation (no `Origin-Agent-Cluster: ?0`).

## Enabling for testing

1. **ChatGPT built-in browser** — supports WebMCP natively; primary judge environment. Open the deployed URL inside ChatGPT and converse.
2. **Chrome 149+** — `chrome://flags/#enable-webmcp-testing` → Enabled → relaunch. (Origin trial Chrome 149–156 exists for production traffic; the local flag suffices for testing. Machine currently has Chrome 152 — update to ≥153 for AbortController unregistration.)

## Gotchas

- Designed for human-in-the-loop, in-browser workflows — no headless assumption.
- Agents pick tools by `description` — write them like API docs, one behavior each.
- The agent cannot be pushed/woken by the page; only tool results, and the toolchange-driven tool list, carry page→agent information (GOAL_PLAN §13 digest pattern).
- Security guide (prompt injection): treat tool inputs as untrusted; keep destructive ops behind confirm + op_token (GOAL_PLAN §13).
