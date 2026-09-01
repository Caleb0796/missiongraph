import { describe, expect, it } from "vitest";

import type { Event, EventInput, TaskNode } from "../src/events.js";
import { fold, GraphValidationError, initialState, reduceEvent, type GraphState } from "../src/reducer.js";
import { baseHandoff } from "./fixtures.js";

const task = (id: string, estimate_min: number): TaskNode => ({
  id,
  title: `Task ${id}`,
  brief: `Complete task ${id}.`,
  estimate_min,
  tags: [],
  state: "queued",
});

function append(state: GraphState, input: EventInput, second = state.seq): GraphState {
  return reduceEvent(state, {
    ...input,
    seq: state.seq + 1,
    project_id: "project",
    ts: `2026-08-30T10:00:${String(second).padStart(2, "0")}.000Z`,
  } as Event);
}

function add(state: GraphState, id: string, estimate: number): GraphState {
  return append(state, {
    actor: "human",
    type: "TASK_ADDED",
    payload: { node: task(id, estimate) },
    idem_key: `add-${id}`,
  });
}

function link(state: GraphState, upstream: string, downstream: string, kind: "depends" | "conflicts" = "depends"): GraphState {
  return append(state, {
    actor: "human",
    type: "EDGE_ADDED",
    payload: { edge_id: `${kind}-${upstream}-${downstream}`, upstream, downstream, kind },
    idem_key: `${kind}-${upstream}-${downstream}`,
  });
}

describe("deterministic reducer", () => {
  it("folds historical worker review-to-done events without applying ingress policy", () => {
    const events: Event[] = [
      {
        seq: 1,
        project_id: "project",
        ts: "2026-08-30T10:00:00.000Z",
        actor: "human",
        type: "TASK_ADDED",
        payload: { node: task("a", 5) },
        idem_key: "add-a",
      },
      {
        seq: 2,
        project_id: "project",
        ts: "2026-08-30T10:01:00.000Z",
        actor: "worker:a",
        type: "NODE_STATE_CHANGED",
        payload: { node_id: "a", from: "queued", to: "running" },
        idem_key: "a-running",
      },
      {
        seq: 3,
        project_id: "project",
        ts: "2026-08-30T10:02:00.000Z",
        actor: "worker:a",
        type: "NODE_STATE_CHANGED",
        payload: { node_id: "a", from: "running", to: "review" },
        idem_key: "a-review",
      },
      {
        seq: 4,
        project_id: "project",
        ts: "2026-08-30T10:03:00.000Z",
        actor: "worker:a",
        type: "NODE_STATE_CHANGED",
        payload: { node_id: "a", from: "review", to: "done" },
        idem_key: "a-done",
      },
    ];

    expect(fold(events).nodes.a?.state).toBe("done");
  });

  it("rejects dependency cycles but excludes conflict edges from cycle checks", () => {
    let state = add(initialState(), "a", 5);
    state = add(state, "b", 10);
    state = link(state, "a", "b");
    state = link(state, "b", "a", "conflicts");

    expect(() => link(state, "b", "a")).toThrow(GraphValidationError);
    expect(state.seq).toBe(4);
  });

  it("derives blocked and ready states as prerequisites complete", () => {
    let state = add(initialState(), "a", 5);
    state = add(state, "b", 10);
    state = link(state, "a", "b");
    expect(state.nodes.a?.availability).toBe("ready");
    expect(state.nodes.b?.availability).toBe("blocked");

    state = append(state, {
      actor: "worker:a",
      type: "NODE_STATE_CHANGED",
      payload: { node_id: "a", from: "queued", to: "running" },
      idem_key: "a-running",
    });
    state = append(state, {
      actor: "worker:a",
      type: "NODE_STATE_CHANGED",
      payload: { node_id: "a", from: "running", to: "review" },
      idem_key: "a-review",
    });
    state = append(state, {
      actor: "supervisor",
      type: "NODE_STATE_CHANGED",
      payload: { node_id: "a", from: "review", to: "done" },
      idem_key: "a-done",
    });

    expect(state.nodes.b?.availability).toBe("ready");
    expect(state.nodes.b?.ready_since).toBe("2026-08-30T10:00:05.000Z");
  });

  it("recomputes the longest remaining path with deterministic ties", () => {
    let state = add(initialState(), "a", 5);
    state = add(state, "b", 10);
    state = add(state, "c", 20);
    expect(state.critical_path).toEqual(["c"]);
    state = link(state, "a", "b");
    expect(state.critical_path).toEqual(["c"]);
    state = link(state, "b", "c");
    expect(state.critical_path).toEqual(["a", "b", "c"]);

    let tied = add(initialState(), "b", 10);
    tied = add(tied, "a", 10);
    expect(tied.critical_path).toEqual(["a"]);

    const zero = add(initialState(), "zero", 0);
    expect(zero.critical_path).toEqual(["zero"]);
  });

  it("tombstones removed tasks and removes their incident edges", () => {
    let state = add(initialState(), "a", 5);
    state = add(state, "b", 10);
    state = link(state, "a", "b");
    state = append(state, {
      actor: "human",
      type: "TASK_REMOVED",
      payload: { node_id: "a", tombstone: true },
      idem_key: "remove-a",
    });

    expect(state.nodes.a).toBeUndefined();
    expect(state.tombstones.a?.node.title).toBe("Task a");
    expect(Object.keys(state.edges)).toEqual([]);
    expect(state.critical_path).toEqual(["b"]);
    expect(() => add(state, "a", 1)).toThrow("already exists");
  });

  it("requires a filed handoff before creating an approval", () => {
    let state = add(initialState(), "a", 5);
    state = append(state, {
      actor: "worker:a",
      type: "NODE_STATE_CHANGED",
      payload: { node_id: "a", from: "queued", to: "running" },
      idem_key: "a-running",
    });
    state = append(state, {
      actor: "worker:a",
      type: "NODE_STATE_CHANGED",
      payload: { node_id: "a", from: "running", to: "review" },
      idem_key: "a-review",
    });
    const approval = {
      actor: "supervisor",
      type: "APPROVAL_CREATED",
      payload: { approval_id: "approval-a", node_id: "a", summary: "Review task a." },
      idem_key: "approval-a",
    } satisfies EventInput;

    expect(() => append(state, approval)).toThrow("has no filed handoff");

    state = append(state, {
      actor: "worker:a",
      type: "HANDOFF_FILED",
      payload: { node_id: "a", handoff: baseHandoff },
      idem_key: "a-handoff",
    });
    state = append(state, approval);

    expect(state.approvals["approval-a"]).toMatchObject({ node_id: "a", status: "pending" });
  });

  it("preserves a split parent as a non-schedulable group with its handoff", () => {
    let state = add(initialState(), "parent", 30);
    state = append(state, {
      actor: "worker:parent",
      type: "NODE_STATE_CHANGED",
      payload: { node_id: "parent", from: "queued", to: "running" },
      idem_key: "parent-running",
    });
    state = append(state, {
      actor: "worker:parent",
      type: "HANDOFF_FILED",
      payload: { node_id: "parent", handoff: baseHandoff },
      idem_key: "parent-handoff",
    });
    state = append(state, {
      actor: "browser_agent",
      type: "TASK_SPLIT",
      payload: {
        parent_id: "parent",
        children: [task("child-a", 10), task("child-b", 15)],
        edge_remap: [],
      },
      idem_key: "split-parent",
    });

    expect(state.nodes.parent).toMatchObject({
      record_type: "group",
      child_ids: ["child-a", "child-b"],
      availability: null,
      assigned: true,
    });
    expect(state.handoffs.parent).toEqual(baseHandoff);
    expect(state.tombstones.parent).toBeUndefined();
    expect(state.critical_path).not.toContain("parent");
    expect(() =>
      append(state, {
        actor: "supervisor",
        type: "NODE_STATE_CHANGED",
        payload: { node_id: "parent", from: "review", to: "done" },
        idem_key: "complete-parent",
      }),
    ).toThrow("non-schedulable group");
  });

  it("clears removed nodes and edges from every client selection", () => {
    let state = add(initialState(), "a", 5);
    state = add(state, "b", 10);
    state = add(state, "c", 15);
    state = link(state, "a", "b");
    state = link(state, "b", "c");
    state = append(state, {
      actor: "human",
      type: "SELECTION_CHANGED",
      payload: { client_id: "client-one", selected: ["a", "depends-a-b", "c"] },
      idem_key: "select-client-one",
    });
    state = append(state, {
      actor: "human",
      type: "SELECTION_CHANGED",
      payload: { client_id: "client-two", selected: ["depends-a-b", "depends-b-c", "b"] },
      idem_key: "select-client-two",
    });
    state = append(state, {
      actor: "human",
      type: "TASK_REMOVED",
      payload: { node_id: "a", tombstone: true },
      idem_key: "remove-a",
    });

    expect(state.selections).toEqual({
      "client-one": ["c"],
      "client-two": ["depends-b-c", "b"],
    });

    state = append(state, {
      actor: "human",
      type: "EDGE_REMOVED",
      payload: { edge_id: "depends-b-c" },
      idem_key: "remove-b-c",
    });

    expect(state.selections).toEqual({ "client-one": ["c"], "client-two": ["b"] });
  });
});
