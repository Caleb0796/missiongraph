export const structuralEventTypes = new Set([
  "TASK_ADDED",
  "TASK_REMOVED",
  "TASK_SPLIT",
  "EDGE_ADDED",
  "EDGE_REMOVED",
  "DISPATCHED",
  "RETRY_REQUESTED",
  "PAUSE_REQUESTED",
  "RESUME_REQUESTED",
  "APPROVED",
  "REJECTED",
  "POLICY_STATED",
  "ANNOTATED",
  "JOURNAL_NOTE",
]);

export interface MissionEvent {
  seq: number;
  project_id: string;
  ts: string;
  actor: string;
  type: string;
  payload: Record<string, unknown>;
  idem_key: string;
}

export interface SnapshotNode {
  id: string;
  record_type?: "task" | "group";
  title: string;
  brief: string;
  state: string;
  availability: string | null;
  assigned: boolean;
  pause_requested: boolean;
}

export interface SnapshotState {
  seq: number;
  nodes: Record<string, SnapshotNode>;
  tombstones?: Record<string, { node: { id: string } }>;
  approvals: Record<string, { status: string; node_id: string }>;
  policies: Record<string, { text: string }>;
  critical_path: string[];
}

export interface Snapshot {
  state: SnapshotState;
  cursor: string;
}

export type SupervisorAction =
  | { act: "spawn_worker"; node_id: string; brief: string }
  | { act: "pause_worker" | "resume_worker" | "kill_worker"; node_id: string }
  | { act: "rebrief_worker"; node_id: string; message: string }
  | { act: "note"; text: string };

export interface SupervisorDecision {
  actions: SupervisorAction[];
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => process.stderr.write(`[bridge] ${message}\n`),
  warn: (message) => process.stderr.write(`[bridge] WARN ${message}\n`),
  error: (message) => process.stderr.write(`[bridge] ERROR ${message}\n`),
};
