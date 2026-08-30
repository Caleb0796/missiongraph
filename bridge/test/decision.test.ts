import { describe, expect, it } from "vitest";

import { parseSupervisorDecision, parseThreadId } from "../src/decision.js";
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
  ])("turns %s into a logged safe no-op", (_label, jsonl) => {
    const logger = new TestLogger();
    expect(parseSupervisorDecision(jsonl, logger)).toEqual({ actions: [] });
    expect(logger.warningMessages).toHaveLength(1);
  });
});
