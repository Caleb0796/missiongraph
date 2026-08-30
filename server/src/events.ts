import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";

import { fold, reduceEvent } from "./reducer.js";

export const nodeStates = ["queued", "running", "review", "done", "failed", "paused"] as const;

export type NodeState = (typeof nodeStates)[number];
export type Actor = "human" | "browser_agent" | "supervisor" | `worker:${string}`;

export interface TaskNode {
  id: string;
  title: string;
  brief: string;
  estimate_min: number;
  tags: string[];
  state: NodeState;
}

export interface Handoff {
  v: 1;
  summary: string;
  files: string[];
  commits: string[];
  tests: "green" | "red" | "none";
  downstream_notes: string;
  deviations: string[];
  artifacts: { label: string; url: string }[];
}

export interface EventPayloads {
  TASK_ADDED: { node: TaskNode };
  TASK_REMOVED: { node_id: string; tombstone: true };
  TASK_SPLIT: {
    parent_id: string;
    children: TaskNode[];
    edge_remap: { edge_id: string; new_target: string }[];
  };
  EDGE_ADDED: {
    edge_id: string;
    upstream: string;
    downstream: string;
    kind: "depends" | "conflicts";
  };
  EDGE_REMOVED: { edge_id: string };
  DISPATCHED: { node_id: string; brief_override?: string; bypass_cap: boolean };
  RETRY_REQUESTED: { node_id: string; guidance: string };
  PAUSE_REQUESTED: { node_id: string };
  RESUME_REQUESTED: { node_id: string };
  APPROVED: {
    approval_id: string;
    node_id: string;
    policy_ref?: string;
    rationale?: string;
  };
  REJECTED: {
    approval_id: string;
    node_id: string;
    policy_ref?: string;
    reason?: string;
  };
  POLICY_STATED: { policy_ref: string; text: string; scope: "session"; session_id: string };
  ANNOTATED: { target_id: string; note: string };
  JOURNAL_NOTE: { text: string };
  NODE_STATE_CHANGED: { node_id: string; from: NodeState; to: NodeState; detail?: string };
  PAUSE_ACKED: { node_id: string };
  WORKER_LOG: { node_id: string; lines: string[] };
  HANDOFF_FILED: { node_id: string; handoff: Handoff };
  DEVIATION_NOTED: {
    node_id: string;
    kind: "estimate" | "scope" | "other";
    text: string;
    est_min?: number;
    actual_min?: number;
  };
  APPROVAL_CREATED: {
    approval_id: string;
    node_id: string;
    summary: string;
    diff_stats?: { lines_added: number; lines_removed: number; files: string[] };
    tests?: "green" | "red" | "none";
  };
  NODE_MOVED: { node_id: string; x: number; y: number };
  SELECTION_CHANGED: { client_id: string; selected: string[] };
}

export type EvType = keyof EventPayloads;

export interface Ev<T extends EvType, P = EventPayloads[T]> {
  seq: number;
  project_id: string;
  ts: string;
  actor: Actor;
  type: T;
  payload: P;
  idem_key: string;
}

export type Event = {
  [T in EvType]: Ev<T, EventPayloads[T]>;
}[EvType];

export type EventInput = {
  [T in EvType]: {
    actor: Actor;
    type: T;
    payload: EventPayloads[T];
    idem_key: string;
  };
}[EvType];

export const eventTypes = [
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
  "NODE_STATE_CHANGED",
  "PAUSE_ACKED",
  "WORKER_LOG",
  "HANDOFF_FILED",
  "DEVIATION_NOTED",
  "APPROVAL_CREATED",
  "NODE_MOVED",
  "SELECTION_CHANGED",
] as const satisfies readonly EvType[];

export const reporterEventTypes = new Set<EvType>([
  "NODE_STATE_CHANGED",
  "PAUSE_ACKED",
  "WORKER_LOG",
  "HANDOFF_FILED",
  "DEVIATION_NOTED",
  "APPROVAL_CREATED",
]);

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventValidationError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EventValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EventValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function number(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new EventValidationError(`${label} must be a finite number >= ${minimum}`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new EventValidationError(`${label} must be a boolean`);
  }
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new EventValidationError(`${label} must be an array`);
  }
  return value.map((item, index) => string(item, `${label}[${index}]`));
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new EventValidationError(`${label} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function taskNode(value: unknown, label: string): TaskNode {
  const item = object(value, label);
  return {
    id: string(item.id, `${label}.id`),
    title: string(item.title, `${label}.title`),
    brief: string(item.brief, `${label}.brief`),
    estimate_min: number(item.estimate_min, `${label}.estimate_min`),
    tags: strings(item.tags, `${label}.tags`),
    state: oneOf(item.state, nodeStates, `${label}.state`),
  };
}

function handoff(value: unknown): Handoff {
  const item = object(value, "payload.handoff");
  if (item.v !== 1) {
    throw new EventValidationError("payload.handoff.v must be 1");
  }
  if (!Array.isArray(item.artifacts)) {
    throw new EventValidationError("payload.handoff.artifacts must be an array");
  }
  return {
    v: 1,
    summary: string(item.summary, "payload.handoff.summary"),
    files: strings(item.files, "payload.handoff.files"),
    commits: strings(item.commits, "payload.handoff.commits"),
    tests: oneOf(item.tests, ["green", "red", "none"] as const, "payload.handoff.tests"),
    downstream_notes: string(item.downstream_notes, "payload.handoff.downstream_notes"),
    deviations: strings(item.deviations, "payload.handoff.deviations"),
    artifacts: item.artifacts.map((artifact, index) => {
      const entry = object(artifact, `payload.handoff.artifacts[${index}]`);
      return {
        label: string(entry.label, `payload.handoff.artifacts[${index}].label`),
        url: string(entry.url, `payload.handoff.artifacts[${index}].url`),
      };
    }),
  };
}

function nodeIdPayload(payload: Record<string, unknown>): { node_id: string } {
  return { node_id: string(payload.node_id, "payload.node_id") };
}

export function parseActor(value: unknown): Actor {
  if (value === "human" || value === "browser_agent" || value === "supervisor") {
    return value;
  }
  if (typeof value === "string" && value.startsWith("worker:") && value.length > 7) {
    return value as `worker:${string}`;
  }
  throw new EventValidationError("actor is invalid");
}

export function parseEventType(value: unknown): EvType {
  return oneOf(value, eventTypes, "type");
}

export function parsePayload<T extends EvType>(type: T, value: unknown): EventPayloads[T] {
  const payload = object(value, "payload");
  let parsed: EventPayloads[EvType];
  switch (type) {
    case "TASK_ADDED":
      parsed = { node: taskNode(payload.node, "payload.node") };
      break;
    case "TASK_REMOVED":
      if (payload.tombstone !== true) throw new EventValidationError("payload.tombstone must be true");
      parsed = { node_id: string(payload.node_id, "payload.node_id"), tombstone: true };
      break;
    case "TASK_SPLIT":
      if (!Array.isArray(payload.children) || !Array.isArray(payload.edge_remap)) {
        throw new EventValidationError("payload.children and payload.edge_remap must be arrays");
      }
      parsed = {
        parent_id: string(payload.parent_id, "payload.parent_id"),
        children: payload.children.map((child, index) => taskNode(child, `payload.children[${index}]`)),
        edge_remap: payload.edge_remap.map((remap, index) => {
          const entry = object(remap, `payload.edge_remap[${index}]`);
          return {
            edge_id: string(entry.edge_id, `payload.edge_remap[${index}].edge_id`),
            new_target: string(entry.new_target, `payload.edge_remap[${index}].new_target`),
          };
        }),
      };
      break;
    case "EDGE_ADDED":
      parsed = {
        edge_id: string(payload.edge_id, "payload.edge_id"),
        upstream: string(payload.upstream, "payload.upstream"),
        downstream: string(payload.downstream, "payload.downstream"),
        kind: oneOf(payload.kind, ["depends", "conflicts"] as const, "payload.kind"),
      };
      break;
    case "EDGE_REMOVED":
      parsed = { edge_id: string(payload.edge_id, "payload.edge_id") };
      break;
    case "DISPATCHED": {
      const brief_override = optionalString(payload.brief_override, "payload.brief_override");
      parsed = {
        ...nodeIdPayload(payload),
        ...(brief_override === undefined ? {} : { brief_override }),
        bypass_cap: boolean(payload.bypass_cap, "payload.bypass_cap"),
      };
      break;
    }
    case "RETRY_REQUESTED":
      parsed = { ...nodeIdPayload(payload), guidance: string(payload.guidance, "payload.guidance") };
      break;
    case "PAUSE_REQUESTED":
    case "RESUME_REQUESTED":
    case "PAUSE_ACKED":
      parsed = nodeIdPayload(payload);
      break;
    case "APPROVED": {
      const policy_ref = optionalString(payload.policy_ref, "payload.policy_ref");
      const rationale = optionalString(payload.rationale, "payload.rationale");
      parsed = {
        approval_id: string(payload.approval_id, "payload.approval_id"),
        node_id: string(payload.node_id, "payload.node_id"),
        ...(policy_ref === undefined ? {} : { policy_ref }),
        ...(rationale === undefined ? {} : { rationale }),
      };
      break;
    }
    case "REJECTED": {
      const policy_ref = optionalString(payload.policy_ref, "payload.policy_ref");
      const reason = optionalString(payload.reason, "payload.reason");
      parsed = {
        approval_id: string(payload.approval_id, "payload.approval_id"),
        node_id: string(payload.node_id, "payload.node_id"),
        ...(policy_ref === undefined ? {} : { policy_ref }),
        ...(reason === undefined ? {} : { reason }),
      };
      break;
    }
    case "POLICY_STATED":
      if (payload.scope !== "session") throw new EventValidationError("payload.scope must be session");
      parsed = {
        policy_ref: string(payload.policy_ref, "payload.policy_ref"),
        text: string(payload.text, "payload.text"),
        scope: "session",
        session_id: string(payload.session_id, "payload.session_id"),
      };
      break;
    case "ANNOTATED":
      parsed = {
        target_id: string(payload.target_id, "payload.target_id"),
        note: string(payload.note, "payload.note"),
      };
      break;
    case "JOURNAL_NOTE":
      parsed = { text: string(payload.text, "payload.text") };
      break;
    case "NODE_STATE_CHANGED": {
      const detail = optionalString(payload.detail, "payload.detail");
      parsed = {
        node_id: string(payload.node_id, "payload.node_id"),
        from: oneOf(payload.from, nodeStates, "payload.from"),
        to: oneOf(payload.to, nodeStates, "payload.to"),
        ...(detail === undefined ? {} : { detail }),
      };
      break;
    }
    case "WORKER_LOG":
      parsed = { ...nodeIdPayload(payload), lines: strings(payload.lines, "payload.lines") };
      break;
    case "HANDOFF_FILED":
      parsed = { ...nodeIdPayload(payload), handoff: handoff(payload.handoff) };
      break;
    case "DEVIATION_NOTED": {
      const est_min = payload.est_min === undefined ? undefined : number(payload.est_min, "payload.est_min");
      const actual_min =
        payload.actual_min === undefined ? undefined : number(payload.actual_min, "payload.actual_min");
      parsed = {
        ...nodeIdPayload(payload),
        kind: oneOf(payload.kind, ["estimate", "scope", "other"] as const, "payload.kind"),
        text: string(payload.text, "payload.text"),
        ...(est_min === undefined ? {} : { est_min }),
        ...(actual_min === undefined ? {} : { actual_min }),
      };
      break;
    }
    case "APPROVAL_CREATED": {
      const diff = payload.diff_stats === undefined ? undefined : object(payload.diff_stats, "payload.diff_stats");
      const tests =
        payload.tests === undefined
          ? undefined
          : oneOf(payload.tests, ["green", "red", "none"] as const, "payload.tests");
      parsed = {
        approval_id: string(payload.approval_id, "payload.approval_id"),
        node_id: string(payload.node_id, "payload.node_id"),
        summary: string(payload.summary, "payload.summary"),
        ...(diff === undefined
          ? {}
          : {
              diff_stats: {
                lines_added: number(diff.lines_added, "payload.diff_stats.lines_added"),
                lines_removed: number(diff.lines_removed, "payload.diff_stats.lines_removed"),
                files: strings(diff.files, "payload.diff_stats.files"),
              },
            }),
        ...(tests === undefined ? {} : { tests }),
      };
      break;
    }
    case "NODE_MOVED":
      parsed = {
        ...nodeIdPayload(payload),
        x: number(payload.x, "payload.x", Number.NEGATIVE_INFINITY),
        y: number(payload.y, "payload.y", Number.NEGATIVE_INFINITY),
      };
      break;
    case "SELECTION_CHANGED":
      parsed = {
        client_id: string(payload.client_id, "payload.client_id"),
        selected: strings(payload.selected, "payload.selected"),
      };
      break;
  }
  return parsed as EventPayloads[T];
}

export function parseEventInput(value: unknown, defaultActor?: Actor): EventInput {
  const input = object(value, "event");
  const type = parseEventType(input.type);
  const actor = input.actor === undefined && defaultActor ? defaultActor : parseActor(input.actor);
  const payload = parsePayload(type, input.payload);
  const idem_key = string(input.idem_key, "idem_key");
  return { actor, type, payload, idem_key } as EventInput;
}

interface EventRow {
  seq: number;
  project_id: string;
  ts: string;
  actor: string;
  type: string;
  payload_json: string;
  idem_key: string;
}

interface ProjectRow {
  id: string;
  visitor_token: string;
  created_at: string;
  seed_project_id: string | null;
}

export interface Project {
  id: string;
  visitor_token: string;
  created_at: string;
  seed_project_id: string | null;
}

export class StaleSequenceError extends Error {
  constructor(readonly currentSeq: number) {
    super(`base_seq is stale; current sequence is ${currentSeq}`);
    this.name = "StaleSequenceError";
  }
}

export class UnknownProjectError extends Error {
  constructor(projectId: string) {
    super(`project ${projectId} does not exist`);
    this.name = "UnknownProjectError";
  }
}

function decodeRow(row: EventRow): Event {
  const stored = JSON.parse(row.payload_json) as { v: number; data: unknown };
  if (stored.v !== 1) throw new EventValidationError(`unsupported payload version ${stored.v}`);
  const type = parseEventType(row.type);
  return {
    seq: row.seq,
    project_id: row.project_id,
    ts: row.ts,
    actor: parseActor(row.actor),
    type,
    payload: parsePayload(type, stored.data),
    idem_key: row.idem_key,
  } as Event;
}

function refs(input: EventInput): { nodeRef: string | null; edgeRef: string | null } {
  const payload = input.payload as Record<string, unknown>;
  if (input.type === "TASK_ADDED") {
    return { nodeRef: (input.payload as EventPayloads["TASK_ADDED"]).node.id, edgeRef: null };
  }
  if (input.type === "TASK_SPLIT") {
    return { nodeRef: (input.payload as EventPayloads["TASK_SPLIT"]).parent_id, edgeRef: null };
  }
  return {
    nodeRef: typeof payload.node_id === "string" ? payload.node_id : null,
    edgeRef:
      typeof payload.edge_id === "string"
        ? payload.edge_id
        : typeof payload.target_id === "string" && input.type === "ANNOTATED"
          ? payload.target_id
          : null,
  };
}

export class EventStore {
  readonly database: DatabaseSync;
  readonly events = new EventEmitter<{ event: [Event] }>();

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        visitor_token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        seed_project_id TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        project_id TEXT NOT NULL REFERENCES projects(id),
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        node_ref TEXT,
        edge_ref TEXT,
        idem_key TEXT NOT NULL,
        PRIMARY KEY (project_id, seq),
        UNIQUE (project_id, idem_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_project_node ON events(project_id, node_ref, seq);
      CREATE INDEX IF NOT EXISTS events_project_edge ON events(project_id, edge_ref, seq);
    `);
  }

  close(): void {
    this.database.close();
  }

  createProject(id: string, visitorToken: string, createdAt: string, seedProjectId?: string): Project {
    this.database
      .prepare(
        "INSERT INTO projects (id, visitor_token, created_at, seed_project_id) VALUES (?, ?, ?, ?)",
      )
      .run(id, visitorToken, createdAt, seedProjectId ?? null);
    return { id, visitor_token: visitorToken, created_at: createdAt, seed_project_id: seedProjectId ?? null };
  }

  getProject(id: string): Project | undefined {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? { ...row } : undefined;
  }

  hasProject(id: string): boolean {
    return this.getProject(id) !== undefined;
  }

  tokenMatches(id: string, token: string): boolean {
    const row = this.database
      .prepare("SELECT 1 AS found FROM projects WHERE id = ? AND visitor_token = ?")
      .get(id, token) as { found: number } | undefined;
    return row?.found === 1;
  }

  latestSeq(projectId: string): number {
    if (!this.hasProject(projectId)) throw new UnknownProjectError(projectId);
    const row = this.database
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project_id = ?")
      .get(projectId) as { seq: number };
    return row.seq;
  }

  listEvents(projectId: string, afterSeq = 0, limit?: number): Event[] {
    if (!this.hasProject(projectId)) throw new UnknownProjectError(projectId);
    const rows = (
      limit === undefined
        ? this.database
            .prepare("SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq")
            .all(projectId, afterSeq)
        : this.database
            .prepare("SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?")
            .all(projectId, afterSeq, limit)
    ) as unknown as EventRow[];
    return rows.map(decodeRow);
  }

  append(
    projectId: string,
    input: EventInput,
    options: { baseSeq?: number; ts?: string } = {},
  ): { event: Event; duplicate: boolean } {
    if (!this.hasProject(projectId)) throw new UnknownProjectError(projectId);
    this.database.exec("BEGIN IMMEDIATE");
    let result: { event: Event; duplicate: boolean };
    try {
      const duplicate = this.database
        .prepare("SELECT * FROM events WHERE project_id = ? AND idem_key = ?")
        .get(projectId, input.idem_key) as EventRow | undefined;
      if (duplicate) {
        result = { event: decodeRow(duplicate), duplicate: true };
      } else {
        const currentSeq = this.latestSeq(projectId);
        if (options.baseSeq !== undefined && options.baseSeq !== currentSeq) {
          throw new StaleSequenceError(currentSeq);
        }
        const event = {
          seq: currentSeq + 1,
          project_id: projectId,
          ts: options.ts ?? new Date().toISOString(),
          ...input,
        } as Event;
        reduceEvent(fold(this.listEvents(projectId)), event);
        const { nodeRef, edgeRef } = refs(input);
        this.database
          .prepare(
            `INSERT INTO events
              (project_id, seq, ts, actor, type, payload_json, node_ref, edge_ref, idem_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            projectId,
            event.seq,
            event.ts,
            event.actor,
            event.type,
            JSON.stringify({ v: 1, data: event.payload }),
            nodeRef,
            edgeRef,
            event.idem_key,
          );
        result = { event, duplicate: false };
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (!result.duplicate) this.events.emit("event", result.event);
    return result;
  }
}
