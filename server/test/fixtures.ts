import type { EventInput, EvType, Handoff, TaskNode } from "../src/events.js";

type InputOf<T extends EvType> = Extract<EventInput, { type: T }>;
type EventFixtures = { [T in EvType]: InputOf<T> };

export const baseTask: TaskNode = {
  id: "task-a",
  title: "Build API",
  brief: "Implement the public API.",
  estimate_min: 30,
  tags: ["server"],
  state: "queued",
};

export const baseHandoff: Handoff = {
  v: 1,
  summary: "The API is implemented and verified.",
  files: ["server/src/http.ts"],
  commits: ["abc123"],
  tests: "green",
  downstream_notes: "Consumers can use the documented routes.",
  deviations: [],
  artifacts: [{ label: "API output", url: "https://example.test/artifact" }],
};

export const eventFixtures = {
  TASK_ADDED: { actor: "human", type: "TASK_ADDED", payload: { node: baseTask }, idem_key: "task-added" },
  TASK_REMOVED: {
    actor: "human",
    type: "TASK_REMOVED",
    payload: { node_id: "task-a", tombstone: true },
    idem_key: "task-removed",
  },
  TASK_SPLIT: {
    actor: "browser_agent",
    type: "TASK_SPLIT",
    payload: {
      parent_id: "task-a",
      children: [{ ...baseTask, id: "task-a-1", title: "Build route" }],
      edge_remap: [{ edge_id: "edge-a", new_target: "task-a-1" }],
    },
    idem_key: "task-split",
  },
  EDGE_ADDED: {
    actor: "human",
    type: "EDGE_ADDED",
    payload: { edge_id: "edge-a", upstream: "task-a", downstream: "task-b", kind: "depends" },
    idem_key: "edge-added",
  },
  EDGE_REMOVED: {
    actor: "human",
    type: "EDGE_REMOVED",
    payload: { edge_id: "edge-a" },
    idem_key: "edge-removed",
  },
  DISPATCHED: {
    actor: "browser_agent",
    type: "DISPATCHED",
    payload: { node_id: "task-a", brief_override: "Start with the handler.", bypass_cap: true },
    idem_key: "dispatched",
  },
  RETRY_REQUESTED: {
    actor: "human",
    type: "RETRY_REQUESTED",
    payload: { node_id: "task-a", guidance: "Use the existing fixture." },
    idem_key: "retry",
  },
  PAUSE_REQUESTED: {
    actor: "human",
    type: "PAUSE_REQUESTED",
    payload: { node_id: "task-a" },
    idem_key: "pause-requested",
  },
  RESUME_REQUESTED: {
    actor: "human",
    type: "RESUME_REQUESTED",
    payload: { node_id: "task-a" },
    idem_key: "resume-requested",
  },
  APPROVED: {
    actor: "human",
    type: "APPROVED",
    payload: { approval_id: "approval-a", node_id: "task-a", rationale: "Checks are green." },
    idem_key: "approved",
  },
  REJECTED: {
    actor: "browser_agent",
    type: "REJECTED",
    payload: {
      approval_id: "approval-a",
      node_id: "task-a",
      policy_ref: "policy-a",
      reason: "The policy requires green tests.",
    },
    idem_key: "rejected",
  },
  POLICY_STATED: {
    actor: "human",
    type: "POLICY_STATED",
    payload: { policy_ref: "policy-a", text: "Approve small green diffs.", scope: "session", session_id: "session-a" },
    idem_key: "policy",
  },
  ANNOTATED: {
    actor: "browser_agent",
    type: "ANNOTATED",
    payload: { target_id: "task-a", note: "This task owns the API boundary." },
    idem_key: "annotated",
  },
  JOURNAL_NOTE: {
    actor: "human",
    type: "JOURNAL_NOTE",
    payload: { text: "Keep the first release intentionally small." },
    idem_key: "journal",
  },
  NODE_STATE_CHANGED: {
    actor: "worker:api",
    type: "NODE_STATE_CHANGED",
    payload: { node_id: "task-a", from: "queued", to: "running", detail: "Worker started." },
    idem_key: "state-changed",
  },
  PAUSE_ACKED: {
    actor: "worker:api",
    type: "PAUSE_ACKED",
    payload: { node_id: "task-a" },
    idem_key: "pause-acked",
  },
  WORKER_LOG: {
    actor: "worker:api",
    type: "WORKER_LOG",
    payload: { node_id: "task-a", lines: ["Implemented the handler."] },
    idem_key: "worker-log",
  },
  HANDOFF_FILED: {
    actor: "worker:api",
    type: "HANDOFF_FILED",
    payload: { node_id: "task-a", handoff: baseHandoff },
    idem_key: "handoff",
  },
  DEVIATION_NOTED: {
    actor: "worker:api",
    type: "DEVIATION_NOTED",
    payload: { node_id: "task-a", kind: "estimate", text: "The route was simpler.", est_min: 30, actual_min: 20 },
    idem_key: "deviation",
  },
  APPROVAL_CREATED: {
    actor: "supervisor",
    type: "APPROVAL_CREATED",
    payload: {
      approval_id: "approval-a",
      node_id: "task-a",
      summary: "Review the API implementation.",
      diff_stats: { lines_added: 40, lines_removed: 3, files: ["server/src/http.ts"] },
      tests: "green",
    },
    idem_key: "approval-created",
  },
  NODE_MOVED: {
    actor: "human",
    type: "NODE_MOVED",
    payload: { node_id: "task-a", x: -10, y: 20 },
    idem_key: "node-moved",
  },
  SELECTION_CHANGED: {
    actor: "human",
    type: "SELECTION_CHANGED",
    payload: { client_id: "client-a", selected: ["task-a"] },
    idem_key: "selection",
  },
} satisfies EventFixtures;
