import { describe, expect, it } from "vitest";

import { buildDigest } from "../src/digest.js";
import type { Event, EventInput, TaskNode } from "../src/events.js";
import { fold } from "../src/reducer.js";
import { baseHandoff } from "./fixtures.js";

const task = (id: string, estimate_min: number): TaskNode => ({
  id,
  title: `Task ${id}`,
  brief: `Complete task ${id}.`,
  estimate_min,
  tags: [],
  state: "queued",
});

function events(inputs: { input: EventInput; ts: string }[]): Event[] {
  return inputs.map(({ input, ts }, index) => ({
    ...input,
    seq: index + 1,
    project_id: "project",
    ts,
  })) as Event[];
}

describe("digest projection", () => {
  it("ranks approvals by delay impact, then oldest age", () => {
    const ordinary = "2026-08-30T10:00:00.000Z";
    const stream = events([
      ...[task("a", 10), task("b", 20), task("c", 50), task("d", 20)].map((node) => ({
        input: { actor: "human", type: "TASK_ADDED", payload: { node }, idem_key: `add-${node.id}` } as EventInput,
        ts: ordinary,
      })),
      {
        input: {
          actor: "human",
          type: "EDGE_ADDED",
          payload: { edge_id: "a-c", upstream: "a", downstream: "c", kind: "depends" },
          idem_key: "a-c",
        },
        ts: ordinary,
      },
      ...["a", "b", "d"].flatMap((node_id, index) => [
        {
          input: {
            actor: `worker:${node_id}`,
            type: "NODE_STATE_CHANGED",
            payload: { node_id, from: "queued", to: "running" },
            idem_key: `${node_id}-running`,
          } as EventInput,
          ts: ordinary,
        },
        {
          input: {
            actor: `worker:${node_id}`,
            type: "HANDOFF_FILED",
            payload: { node_id, handoff: baseHandoff },
            idem_key: `${node_id}-handoff`,
          } as EventInput,
          ts: ordinary,
        },
        {
          input: {
            actor: "supervisor",
            type: "APPROVAL_CREATED",
            payload: { approval_id: `approval-${node_id}`, node_id, summary: `Review task ${node_id}.` },
            idem_key: `${node_id}-approval`,
          } as EventInput,
          ts: `2026-08-30T10:0${[3, 1, 2][index]}:00.000Z`,
        },
      ]),
    ]);
    const state = fold(stream);
    const digest = buildDigest(state, stream);

    expect(digest.summary.pending_approvals.map((approval) => approval.approval_id)).toEqual([
      "approval-a",
      "approval-b",
      "approval-d",
    ]);
    expect(digest.summary.pending_approvals[0]?.delay_impact_min).toBe(60);
  });

  it("bounds readable changes to the newest 50 events", () => {
    const stream = events(
      Array.from({ length: 60 }, (_, index) => ({
        input: {
          actor: "human",
          type: "JOURNAL_NOTE",
          payload: { text: `Decision ${index + 1}.` },
          idem_key: `journal-${index + 1}`,
        },
        ts: `2026-08-30T10:00:${String(index).padStart(2, "0")}.000Z`,
      })),
    );
    const digest = buildDigest(fold(stream), stream, 0);

    expect(digest.changes_since).toHaveLength(50);
    expect(digest.changes_since[0]?.seq).toBe(11);
    expect(digest.changes_since.every((change) => change.one_liner.startsWith("Human"))).toBe(true);
    expect(digest.cursor).toBe("60");
  });
});
