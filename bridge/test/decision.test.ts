import { describe, expect, it } from "vitest";

import { parseSupervisorDecision, parseThreadId, validateSupervisorDecision } from "../src/decision.js";
import type { Snapshot, SupervisorDecision } from "../src/types.js";
import { TestLogger } from "./helpers.js";

function agentMessage(text: string): string {
  return JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
}

describe("supervisor JSONL parsing", () => {
  it("extracts the thread and validates the final decision exactly", () => {
    const logger = new TestLogger();
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      agentMessage('{"actions":[{"act":"spawn_worker","node_id":"node-a","brief":"Build A."}]}'),
    ].join("\n");

    expect(parseThreadId(jsonl)).toBe("thread-1");
    expect(parseSupervisorDecision(jsonl, logger)).toEqual({
      actions: [{ act: "spawn_worker", node_id: "node-a", brief: "Build A." }],
    });
    expect(logger.warningMessages).toEqual([]);
  });

  it.each([
    ["malformed JSON", agentMessage("not-json")],
    ["unknown action", agentMessage('{"actions":[{"act":"merge_everything"}]}')],
    ["extra decision fields", agentMessage('{"actions":[],"comment":"no"}')],
    ["missing decision", JSON.stringify({ type: "turn.completed" })],
  ])("rejects %s so the bridge can retry it once", (_label, jsonl) => {
    const logger = new TestLogger();
    expect(parseSupervisorDecision(jsonl, logger)).toBeUndefined();
    expect(logger.warningMessages).toHaveLength(1);
  });

  it("bounds and authorizes decision actions against the latest snapshot", () => {
    const snapshot: Snapshot = {
      cursor: "1",
      state: {
        seq: 1,
        nodes: {
          a: { id: "a", title: "A", brief: "A", state: "queued", availability: "ready", assigned: false, pause_requested: false },
          done: { id: "done", title: "Done", brief: "Done", state: "done", availability: null, assigned: true, pause_requested: false },
        },
        tombstones: { removed: { node: { id: "removed" } } },
        approvals: {},
        policies: {},
        critical_path: ["a"],
      },
    };
    const bounded = validateSupervisorDecision(
      { actions: Array.from({ length: 12 }, (_, index) => ({ act: "note", text: `note ${index}` })) },
      snapshot,
    );
    const guarded: SupervisorDecision = {
      actions: [
        { act: "spawn_worker", node_id: "a", brief: "Build A." },
        { act: "spawn_worker", node_id: "a", brief: "Build A twice." },
        { act: "rebrief_worker", node_id: "a", message: "x".repeat(16 * 1024 + 1) },
        { act: "pause_worker", node_id: "ghost" },
        { act: "spawn_worker", node_id: "done", brief: "Again." },
        { act: "spawn_worker", node_id: "removed", brief: "Restore." },
        { act: "note", text: "x".repeat(16 * 1024 + 1) },
      ],
    };
    const validated = validateSupervisorDecision(guarded, snapshot);

    expect(bounded.decision.actions).toHaveLength(10);
    expect(bounded.journal).toEqual([expect.stringContaining("per-turn cap of 10")]);
    expect(validated.decision.actions).toEqual([
      { act: "spawn_worker", node_id: "a", brief: "Build A." },
    ]);
    expect(validated.journal).toEqual([
      expect.stringContaining("duplicate spawn_worker"),
      expect.stringContaining("exceeded 16 KB"),
      expect.stringContaining("unknown node ghost"),
      expect.stringContaining("done node done"),
      expect.stringContaining("tombstoned node removed"),
      expect.stringContaining("note because its text exceeded 16 KB"),
    ]);
  });
});
