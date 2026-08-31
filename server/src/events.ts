import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";

import { fold, reduceEvent } from "./reducer.js";

export const nodeStates = ["queued", "running", "review", "done", "failed", "paused"] as const;

export type NodeState = (typeof nodeStates)[number];
export type Actor = "human" | "browser_agent" | "supervisor" | `worker:${string}`;
export type ReporterActor = Exclude<Actor, "human" | "browser_agent">;

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

export type HumanAction = "approve" | "reject" | "dispatch" | "pause" | "resume" | "structural";

export interface AuthorizationAudit {
  capability_ref: string;
  policy_text?: string;
  confirmed_at: string;
  request_origin: string;
  use_nonce: string;
}

export interface EventPayloads {
  TASK_ADDED: { node: TaskNode };
  TASK_REMOVED: { node_id: string; tombstone: true; authorization?: AuthorizationAudit };
  TASK_SPLIT: {
    parent_id: string;
    children: TaskNode[];
    edge_remap: { edge_id: string; new_target: string }[];
    authorization?: AuthorizationAudit;
  };
  EDGE_ADDED: {
    edge_id: string;
    upstream: string;
    downstream: string;
    kind: "depends" | "conflicts";
    authorization?: AuthorizationAudit;
  };
  EDGE_REMOVED: { edge_id: string; authorization?: AuthorizationAudit };
  DISPATCHED: {
    node_id: string;
    brief_override?: string;
    bypass_cap: boolean;
    authorization?: AuthorizationAudit;
  };
  RETRY_REQUESTED: { node_id: string; guidance: string };
  PAUSE_REQUESTED: { node_id: string; authorization?: AuthorizationAudit };
  RESUME_REQUESTED: { node_id: string; authorization?: AuthorizationAudit };
  APPROVED: {
    approval_id: string;
    node_id: string;
    policy_ref?: string;
    rationale?: string;
    authorization?: AuthorizationAudit;
  };
  REJECTED: {
    approval_id: string;
    node_id: string;
    policy_ref?: string;
    reason?: string;
    authorization?: AuthorizationAudit;
  };
  POLICY_STATED: {
    policy_ref: string;
    text: string;
    scope: "session";
    session_id: string;
    allowed_actions?: ("approve" | "reject")[];
    max_uses?: number;
    expires_at?: string;
    confirmed_at?: string;
    request_origin?: string;
  };
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
  if (typeof value !== "string") {
    throw new EventValidationError(`${label} must be a string`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (parsed.length === 0) throw new EventValidationError(`${label} must not be empty`);
  return parsed;
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

function optionalIdentifier(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : identifier(value, label);
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
    id: identifier(item.id, `${label}.id`),
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

function authorizationAudit(value: unknown): AuthorizationAudit {
  const item = object(value, "payload.authorization");
  return {
    capability_ref: identifier(item.capability_ref, "payload.authorization.capability_ref"),
    ...(item.policy_text === undefined
      ? {}
      : { policy_text: string(item.policy_text, "payload.authorization.policy_text") }),
    confirmed_at: identifier(item.confirmed_at, "payload.authorization.confirmed_at"),
    request_origin: identifier(item.request_origin, "payload.authorization.request_origin"),
    use_nonce: identifier(item.use_nonce, "payload.authorization.use_nonce"),
  };
}

function authorizationField(payload: Record<string, unknown>): { authorization?: AuthorizationAudit } {
  return payload.authorization === undefined
    ? {}
    : { authorization: authorizationAudit(payload.authorization) };
}

function nodeIdPayload(payload: Record<string, unknown>): { node_id: string } {
  return { node_id: identifier(payload.node_id, "payload.node_id") };
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
      parsed = {
        node_id: identifier(payload.node_id, "payload.node_id"),
        tombstone: true,
        ...authorizationField(payload),
      };
      break;
    case "TASK_SPLIT":
      if (!Array.isArray(payload.children) || !Array.isArray(payload.edge_remap)) {
        throw new EventValidationError("payload.children and payload.edge_remap must be arrays");
      }
      parsed = {
        parent_id: identifier(payload.parent_id, "payload.parent_id"),
        children: payload.children.map((child, index) => taskNode(child, `payload.children[${index}]`)),
        edge_remap: payload.edge_remap.map((remap, index) => {
          const entry = object(remap, `payload.edge_remap[${index}]`);
          return {
            edge_id: identifier(entry.edge_id, `payload.edge_remap[${index}].edge_id`),
            new_target: identifier(entry.new_target, `payload.edge_remap[${index}].new_target`),
          };
        }),
        ...authorizationField(payload),
      };
      break;
    case "EDGE_ADDED":
      parsed = {
        edge_id: identifier(payload.edge_id, "payload.edge_id"),
        upstream: identifier(payload.upstream, "payload.upstream"),
        downstream: identifier(payload.downstream, "payload.downstream"),
        kind: oneOf(payload.kind, ["depends", "conflicts"] as const, "payload.kind"),
        ...authorizationField(payload),
      };
      break;
    case "EDGE_REMOVED":
      parsed = {
        edge_id: identifier(payload.edge_id, "payload.edge_id"),
        ...authorizationField(payload),
      };
      break;
    case "DISPATCHED": {
      const brief_override = optionalString(payload.brief_override, "payload.brief_override");
      parsed = {
        ...nodeIdPayload(payload),
        ...(brief_override === undefined ? {} : { brief_override }),
        bypass_cap: boolean(payload.bypass_cap, "payload.bypass_cap"),
        ...authorizationField(payload),
      };
      break;
    }
    case "RETRY_REQUESTED":
      parsed = { ...nodeIdPayload(payload), guidance: string(payload.guidance, "payload.guidance") };
      break;
    case "PAUSE_REQUESTED":
    case "RESUME_REQUESTED":
      parsed = { ...nodeIdPayload(payload), ...authorizationField(payload) };
      break;
    case "PAUSE_ACKED":
      parsed = nodeIdPayload(payload);
      break;
    case "APPROVED": {
      const policy_ref = optionalIdentifier(payload.policy_ref, "payload.policy_ref");
      const rationale = optionalString(payload.rationale, "payload.rationale");
      const authorization =
        payload.authorization === undefined ? undefined : authorizationAudit(payload.authorization);
      parsed = {
        approval_id: identifier(payload.approval_id, "payload.approval_id"),
        node_id: identifier(payload.node_id, "payload.node_id"),
        ...(policy_ref === undefined ? {} : { policy_ref }),
        ...(rationale === undefined ? {} : { rationale }),
        ...(authorization === undefined ? {} : { authorization }),
      };
      break;
    }
    case "REJECTED": {
      const policy_ref = optionalIdentifier(payload.policy_ref, "payload.policy_ref");
      const reason = optionalString(payload.reason, "payload.reason");
      const authorization =
        payload.authorization === undefined ? undefined : authorizationAudit(payload.authorization);
      parsed = {
        approval_id: identifier(payload.approval_id, "payload.approval_id"),
        node_id: identifier(payload.node_id, "payload.node_id"),
        ...(policy_ref === undefined ? {} : { policy_ref }),
        ...(reason === undefined ? {} : { reason }),
        ...(authorization === undefined ? {} : { authorization }),
      };
      break;
    }
    case "POLICY_STATED":
      if (payload.scope !== "session") throw new EventValidationError("payload.scope must be session");
      if (
        payload.allowed_actions !== undefined &&
        (!Array.isArray(payload.allowed_actions) ||
          payload.allowed_actions.some((action) => action !== "approve" && action !== "reject"))
      ) {
        throw new EventValidationError("payload.allowed_actions must contain approve or reject");
      }
      parsed = {
        policy_ref: identifier(payload.policy_ref, "payload.policy_ref"),
        text: string(payload.text, "payload.text"),
        scope: "session",
        session_id: identifier(payload.session_id, "payload.session_id"),
        ...(payload.allowed_actions === undefined
          ? {}
          : { allowed_actions: [...payload.allowed_actions] as ("approve" | "reject")[] }),
        ...(payload.max_uses === undefined
          ? {}
          : { max_uses: number(payload.max_uses, "payload.max_uses", 1) }),
        ...(payload.expires_at === undefined
          ? {}
          : { expires_at: identifier(payload.expires_at, "payload.expires_at") }),
        ...(payload.confirmed_at === undefined
          ? {}
          : { confirmed_at: identifier(payload.confirmed_at, "payload.confirmed_at") }),
        ...(payload.request_origin === undefined
          ? {}
          : { request_origin: identifier(payload.request_origin, "payload.request_origin") }),
      };
      break;
    case "ANNOTATED":
      parsed = {
        target_id: identifier(payload.target_id, "payload.target_id"),
        note: string(payload.note, "payload.note"),
      };
      break;
    case "JOURNAL_NOTE":
      parsed = { text: string(payload.text, "payload.text") };
      break;
    case "NODE_STATE_CHANGED": {
      const detail = optionalString(payload.detail, "payload.detail");
      parsed = {
        node_id: identifier(payload.node_id, "payload.node_id"),
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
        approval_id: identifier(payload.approval_id, "payload.approval_id"),
        node_id: identifier(payload.node_id, "payload.node_id"),
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
        client_id: identifier(payload.client_id, "payload.client_id"),
        selected: (() => {
          if (!Array.isArray(payload.selected)) throw new EventValidationError("payload.selected must be an array");
          return payload.selected.map((item, index) => identifier(item, `payload.selected[${index}]`));
        })(),
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
  const idem_key = identifier(input.idem_key, "idem_key");
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

export interface ReporterCredential {
  project_id: string;
  actor: ReporterActor;
  token: string;
  expires_at: string;
}

export interface ReporterIdentity {
  project_id: string;
  actor: ReporterActor;
  expires_at: string;
}

export interface BrowserSession {
  id: string;
  token: string;
  project_id: string;
  created_at: string;
  expires_at: string;
}

export interface HumanDraft {
  id: string;
  project_id: string;
  session_id: string;
  kind: "policy" | "action";
  actions: HumanAction[];
  subject_hash: string;
  display_text: string;
  policy_text?: string;
  max_uses: number;
  created_at: string;
  expires_at: string;
}

export interface HumanCapability {
  ref: string;
  token: string;
  project_id: string;
  session_id: string;
  kind: "policy" | "action";
  actions: HumanAction[];
  subject_hash: string;
  policy_text?: string;
  max_uses: number;
  created_at: string;
  expires_at: string;
  confirmed_at: string;
  request_origin: string;
}

export interface HumanCapabilityAudit {
  ref: string;
  kind: "policy" | "action";
  policy_text?: string;
  confirmed_at: string;
  request_origin: string;
  use_nonce: string;
}

interface HumanDraftRow {
  id: string;
  project_id: string;
  session_id: string;
  kind: "policy" | "action";
  actions_json: string;
  subject_hash: string;
  display_text: string;
  policy_text: string | null;
  max_uses: number;
  created_at: string;
  expires_at: string;
  confirmed_at: string | null;
  denied_at: string | null;
}

interface HumanCapabilityRow {
  ref: string;
  project_id: string;
  session_id: string;
  kind: "policy" | "action";
  actions_json: string;
  subject_hash: string;
  policy_text: string | null;
  max_uses: number;
  created_at: string;
  expires_at: string;
  confirmed_at: string;
  request_origin: string;
}

export class CapabilityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

export interface CreateProjectOptions {
  seedProjectId?: string;
  reporterToken?: string;
}

export interface ImportedEvent {
  input: EventInput;
  ts: string;
}

export interface CreatedProject extends Project {
  reporter_credential: ReporterCredential;
}

const reporterCredentialLifetimeMs = 15 * 60 * 1_000;

function reporterActor(actor: Actor): ReporterActor {
  if (actor === "supervisor") return actor;
  if (actor.startsWith("worker:")) return actor as `worker:${string}`;
  throw new EventValidationError("reporter credential actor must be supervisor or worker:<id>");
}

function reporterTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function reporterCredential(
  projectId: string,
  actor: Actor,
  token: string,
  expiresAt: string,
): ReporterCredential {
  if (token.length === 0) throw new EventValidationError("reporter credential token must not be empty");
  return { project_id: projectId, actor: reporterActor(actor), token, expires_at: expiresAt };
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
      CREATE TABLE IF NOT EXISTS mutation_batches (
        project_id TEXT NOT NULL REFERENCES projects(id),
        idem_key TEXT NOT NULL,
        seqs_json TEXT NOT NULL CHECK(json_valid(seqs_json)),
        PRIMARY KEY (project_id, idem_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reporter_credentials (
        token_hash TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        actor TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS browser_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS human_drafts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('policy', 'action')),
        actions_json TEXT NOT NULL CHECK(json_valid(actions_json)),
        subject_hash TEXT NOT NULL,
        display_text TEXT NOT NULL,
        policy_text TEXT,
        max_uses INTEGER NOT NULL CHECK(max_uses > 0),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        confirmed_at TEXT,
        denied_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS human_capabilities (
        ref TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('policy', 'action')),
        actions_json TEXT NOT NULL CHECK(json_valid(actions_json)),
        subject_hash TEXT NOT NULL,
        policy_text TEXT,
        max_uses INTEGER NOT NULL CHECK(max_uses > 0),
        uses INTEGER NOT NULL DEFAULT 0 CHECK(uses >= 0),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        request_origin TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS human_capability_uses (
        capability_ref TEXT NOT NULL REFERENCES human_capabilities(ref),
        nonce TEXT NOT NULL,
        used_at TEXT NOT NULL,
        PRIMARY KEY (capability_ref, nonce)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_project_node ON events(project_id, node_ref, seq);
      CREATE INDEX IF NOT EXISTS events_project_edge ON events(project_id, edge_ref, seq);
      CREATE INDEX IF NOT EXISTS reporter_credentials_project ON reporter_credentials(project_id, expires_at);
      CREATE INDEX IF NOT EXISTS browser_sessions_project ON browser_sessions(project_id, expires_at);
      CREATE INDEX IF NOT EXISTS human_drafts_project ON human_drafts(project_id, session_id, expires_at);
      CREATE INDEX IF NOT EXISTS human_capabilities_project ON human_capabilities(project_id, session_id, expires_at);
    `);
  }

  close(): void {
    this.database.close();
  }

  createProject(
    id: string,
    visitorToken: string,
    createdAt: string,
    options: CreateProjectOptions = {},
  ): CreatedProject {
    const project = {
      id,
      visitor_token: visitorToken,
      created_at: createdAt,
      seed_project_id: options.seedProjectId ?? null,
    };
    const credential = reporterCredential(
      id,
      "supervisor",
      options.reporterToken ?? randomUUID(),
      new Date(Date.parse(createdAt) + reporterCredentialLifetimeMs).toISOString(),
    );
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          "INSERT INTO projects (id, visitor_token, created_at, seed_project_id) VALUES (?, ?, ?, ?)",
        )
        .run(project.id, project.visitor_token, project.created_at, project.seed_project_id);
      this.database
        .prepare(
          "INSERT INTO reporter_credentials (token_hash, project_id, actor, expires_at) VALUES (?, ?, ?, ?)",
        )
        .run(reporterTokenHash(credential.token), credential.project_id, credential.actor, credential.expires_at);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { ...project, reporter_credential: credential };
  }

  importProject(
    id: string,
    visitorToken: string,
    createdAt: string,
    imported: readonly ImportedEvent[],
    options: CreateProjectOptions = {},
  ): CreatedProject {
    const project = {
      id,
      visitor_token: visitorToken,
      created_at: createdAt,
      seed_project_id: options.seedProjectId ?? null,
    };
    const credential = reporterCredential(
      id,
      "supervisor",
      options.reporterToken ?? randomUUID(),
      new Date(Date.parse(createdAt) + reporterCredentialLifetimeMs).toISOString(),
    );
    const idemKeys = new Set<string>();
    const events = imported.map(({ input, ts }, index) => {
      if (!Number.isFinite(Date.parse(ts))) throw new EventValidationError(`events[${index}].ts is invalid`);
      if (idemKeys.has(input.idem_key)) {
        throw new EventValidationError(`events[${index}].idem_key is duplicated`);
      }
      idemKeys.add(input.idem_key);
      return {
        seq: index + 1,
        project_id: id,
        ts,
        ...input,
      } as Event;
    });
    fold(events);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          "INSERT INTO projects (id, visitor_token, created_at, seed_project_id) VALUES (?, ?, ?, ?)",
        )
        .run(project.id, project.visitor_token, project.created_at, project.seed_project_id);
      this.database
        .prepare(
          "INSERT INTO reporter_credentials (token_hash, project_id, actor, expires_at) VALUES (?, ?, ?, ?)",
        )
        .run(reporterTokenHash(credential.token), credential.project_id, credential.actor, credential.expires_at);
      const insert = this.database.prepare(
        `INSERT INTO events
          (project_id, seq, ts, actor, type, payload_json, node_ref, edge_ref, idem_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const event of events) {
        const { nodeRef, edgeRef } = refs(event as EventInput);
        insert.run(
          event.project_id,
          event.seq,
          event.ts,
          event.actor,
          event.type,
          JSON.stringify({ v: 1, data: event.payload }),
          nodeRef,
          edgeRef,
          event.idem_key,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    for (const event of events) this.events.emit("event", event);
    return { ...project, reporter_credential: credential };
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

  issueReporterCredential(
    projectId: string,
    actor: ReporterActor,
    issuedAt: string,
    token: string = randomUUID(),
  ): ReporterCredential {
    if (!this.hasProject(projectId)) throw new UnknownProjectError(projectId);
    const credential = reporterCredential(
      projectId,
      actor,
      token,
      new Date(Date.parse(issuedAt) + reporterCredentialLifetimeMs).toISOString(),
    );
    this.database
      .prepare(
        "INSERT INTO reporter_credentials (token_hash, project_id, actor, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(reporterTokenHash(credential.token), credential.project_id, credential.actor, credential.expires_at);
    return credential;
  }

  authenticateReporter(projectId: string, token: string, at: string): ReporterIdentity | undefined {
    if (token.length === 0) return undefined;
    const row = this.database
      .prepare(
        `SELECT project_id, actor, expires_at
         FROM reporter_credentials
         WHERE token_hash = ? AND project_id = ? AND expires_at > ?`,
      )
      .get(reporterTokenHash(token), projectId, at) as
      | { project_id: string; actor: string; expires_at: string }
      | undefined;
    if (!row) return undefined;
    return { project_id: row.project_id, actor: reporterActor(parseActor(row.actor)), expires_at: row.expires_at };
  }

  issueBrowserSession(session: BrowserSession): BrowserSession {
    if (!this.hasProject(session.project_id)) throw new UnknownProjectError(session.project_id);
    this.database
      .prepare(
        `INSERT INTO browser_sessions (id, token_hash, project_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        reporterTokenHash(session.token),
        session.project_id,
        session.created_at,
        session.expires_at,
      );
    return session;
  }

  browserSessionMatches(
    projectId: string,
    sessionId: string,
    token: string,
    at: string,
  ): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 AS found FROM browser_sessions
         WHERE id = ? AND token_hash = ? AND project_id = ? AND expires_at > ?`,
      )
      .get(sessionId, reporterTokenHash(token), projectId, at) as { found: number } | undefined;
    return row?.found === 1;
  }

  stageHumanDraft(input: HumanDraft): HumanDraft {
    if (!this.hasProject(input.project_id)) throw new UnknownProjectError(input.project_id);
    this.database
      .prepare(
        `INSERT INTO human_drafts
          (id, project_id, session_id, kind, actions_json, subject_hash, display_text,
           policy_text, max_uses, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.project_id,
        input.session_id,
        input.kind,
        JSON.stringify(input.actions),
        input.subject_hash,
        input.display_text,
        input.policy_text ?? null,
        input.max_uses,
        input.created_at,
        input.expires_at,
      );
    return input;
  }

  confirmHumanDraft(input: {
    projectId: string;
    sessionId: string;
    draftId: string;
    kind: "policy" | "action";
    confirmedAt: string;
    requestOrigin: string;
    token: string;
  }): HumanCapability {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const capability = this.confirmHumanDraftWithinTransaction(input);
      this.database.exec("COMMIT");
      return capability;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  confirmPolicyDraft(input: {
    projectId: string;
    sessionId: string;
    draftId: string;
    confirmedAt: string;
    requestOrigin: string;
    token: string;
  }): { capability: HumanCapability; event: Event; duplicate: boolean } {
    if (!this.hasProject(input.projectId)) throw new UnknownProjectError(input.projectId);
    this.database.exec("BEGIN IMMEDIATE");
    let result: { capability: HumanCapability; event: Event; duplicate: boolean };
    try {
      const capability = this.confirmHumanDraftWithinTransaction({
        ...input,
        kind: "policy",
      });
      const appended = this.appendWithinTransaction(
        input.projectId,
        {
          actor: "human",
          type: "POLICY_STATED",
          payload: {
            policy_ref: capability.ref,
            text: capability.policy_text ?? "",
            scope: "session",
            session_id: input.sessionId,
            allowed_actions: ["approve", "reject"],
            max_uses: capability.max_uses,
            expires_at: capability.expires_at,
            confirmed_at: capability.confirmed_at,
            request_origin: capability.request_origin,
          },
          idem_key: `policy-confirm:${input.draftId}`,
        },
        { sessionId: input.sessionId, ts: capability.confirmed_at },
      );
      result = { capability, ...appended };
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (!result.duplicate) this.events.emit("event", result.event);
    return result;
  }

  private confirmHumanDraftWithinTransaction(input: {
    projectId: string;
    sessionId: string;
    draftId: string;
    kind: "policy" | "action";
    confirmedAt: string;
    requestOrigin: string;
    token: string;
  }): HumanCapability {
    const row = this.database
      .prepare("SELECT * FROM human_drafts WHERE id = ?")
      .get(input.draftId) as HumanDraftRow | undefined;
    if (
      !row ||
      row.project_id !== input.projectId ||
      row.session_id !== input.sessionId ||
      row.kind !== input.kind
    ) {
      throw new CapabilityError("capability_invalid", "The confirmation draft does not belong to this project session.");
    }
    if (row.confirmed_at) {
      const existing = this.database
        .prepare(
          `SELECT ref, project_id, session_id, kind, actions_json, subject_hash, policy_text,
                  max_uses, created_at, expires_at, confirmed_at, request_origin
           FROM human_capabilities WHERE ref = ?`,
        )
        .get(input.draftId) as HumanCapabilityRow | undefined;
      if (
        !existing ||
        existing.project_id !== input.projectId ||
        existing.session_id !== input.sessionId ||
        existing.kind !== input.kind
      ) {
        throw new CapabilityError("capability_replayed", "This confirmation draft was already used.");
      }
      this.database
        .prepare("UPDATE human_capabilities SET token_hash = ? WHERE ref = ?")
        .run(reporterTokenHash(input.token), existing.ref);
      return {
        ref: existing.ref,
        token: input.token,
        project_id: existing.project_id,
        session_id: existing.session_id,
        kind: existing.kind,
        actions: JSON.parse(existing.actions_json) as HumanAction[],
        subject_hash: existing.subject_hash,
        ...(existing.policy_text === null ? {} : { policy_text: existing.policy_text }),
        max_uses: existing.max_uses,
        created_at: existing.created_at,
        expires_at: existing.expires_at,
        confirmed_at: existing.confirmed_at,
        request_origin: existing.request_origin,
      };
    }
    if (row.denied_at) {
      throw new CapabilityError("capability_denied", "This confirmation draft was denied.");
    }
    if (row.expires_at <= input.confirmedAt) {
      throw new CapabilityError("capability_expired", "This confirmation draft expired.");
    }
    const capability: HumanCapability = {
      ref: input.draftId,
      token: input.token,
      project_id: row.project_id,
      session_id: row.session_id,
      kind: row.kind,
      actions: JSON.parse(row.actions_json) as HumanAction[],
      subject_hash: row.subject_hash,
      ...(row.policy_text === null ? {} : { policy_text: row.policy_text }),
      max_uses: row.max_uses,
      created_at: row.created_at,
      expires_at: row.expires_at,
      confirmed_at: input.confirmedAt,
      request_origin: input.requestOrigin,
    };
    const changed = this.database
      .prepare(
        "UPDATE human_drafts SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL AND denied_at IS NULL",
      )
      .run(input.confirmedAt, row.id);
    if (changed.changes !== 1) {
      throw new CapabilityError("capability_replayed", "This confirmation draft was already used.");
    }
    this.database
      .prepare(
        `INSERT INTO human_capabilities
          (ref, token_hash, project_id, session_id, kind, actions_json, subject_hash,
           policy_text, max_uses, created_at, expires_at, confirmed_at, request_origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        capability.ref,
        reporterTokenHash(capability.token),
        capability.project_id,
        capability.session_id,
        capability.kind,
        JSON.stringify(capability.actions),
        capability.subject_hash,
        capability.policy_text ?? null,
        capability.max_uses,
        capability.created_at,
        capability.expires_at,
        capability.confirmed_at,
        capability.request_origin,
      );
    return capability;
  }

  denyHumanDraft(input: {
    projectId: string;
    sessionId: string;
    draftId: string;
    deniedAt: string;
  }): void {
    const row = this.database
      .prepare("SELECT project_id, session_id, confirmed_at, denied_at FROM human_drafts WHERE id = ?")
      .get(input.draftId) as
      | {
          project_id: string;
          session_id: string;
          confirmed_at: string | null;
          denied_at: string | null;
        }
      | undefined;
    if (!row || row.project_id !== input.projectId || row.session_id !== input.sessionId) {
      throw new CapabilityError("capability_invalid", "The confirmation draft does not belong to this project session.");
    }
    if (row.confirmed_at) {
      throw new CapabilityError("capability_replayed", "This confirmation draft was already used.");
    }
    if (row.denied_at) return;
    this.database
      .prepare(
        "UPDATE human_drafts SET denied_at = ? WHERE id = ? AND confirmed_at IS NULL AND denied_at IS NULL",
      )
      .run(input.deniedAt, input.draftId);
  }

  consumeHumanCapability(input: {
    projectId: string;
    sessionId: string;
    ref: string;
    token: string;
    action: HumanAction;
    subjectHash: string;
    nonce: string;
    usedAt: string;
  }): HumanCapabilityAudit {
    const row = this.database
      .prepare(
        `SELECT ref, project_id, session_id, kind, actions_json, subject_hash, policy_text,
                max_uses, uses, expires_at, confirmed_at, request_origin
         FROM human_capabilities WHERE ref = ? AND token_hash = ?`,
      )
      .get(input.ref, reporterTokenHash(input.token)) as
      | {
          ref: string;
          project_id: string;
          session_id: string;
          kind: "policy" | "action";
          actions_json: string;
          subject_hash: string;
          policy_text: string | null;
          max_uses: number;
          uses: number;
          expires_at: string;
          confirmed_at: string;
          request_origin: string;
        }
      | undefined;
    if (!row || row.project_id !== input.projectId || row.session_id !== input.sessionId) {
      throw new CapabilityError("capability_invalid", "The human-presence capability is invalid for this project session.");
    }
    if (row.expires_at <= input.usedAt) {
      throw new CapabilityError("capability_expired", "The human-presence capability expired.");
    }
    const actions = JSON.parse(row.actions_json) as HumanAction[];
    if (!actions.includes(input.action) || row.subject_hash !== input.subjectHash) {
      throw new CapabilityError("capability_invalid", "The human-presence capability does not authorize this action.");
    }
    if (row.uses >= row.max_uses) {
      throw new CapabilityError("capability_exhausted", "The human-presence capability has no uses remaining.");
    }
    const prior = this.database
      .prepare("SELECT 1 AS found FROM human_capability_uses WHERE capability_ref = ? AND nonce = ?")
      .get(row.ref, input.nonce) as { found: number } | undefined;
    if (prior) throw new CapabilityError("capability_replayed", "This capability use nonce was already consumed.");
    this.database
      .prepare("INSERT INTO human_capability_uses (capability_ref, nonce, used_at) VALUES (?, ?, ?)")
      .run(row.ref, input.nonce, input.usedAt);
    this.database
      .prepare("UPDATE human_capabilities SET uses = uses + 1 WHERE ref = ?")
      .run(row.ref);
    return {
      ref: row.ref,
      kind: row.kind,
      ...(row.policy_text === null ? {} : { policy_text: row.policy_text }),
      confirmed_at: row.confirmed_at,
      request_origin: row.request_origin,
      use_nonce: input.nonce,
    };
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
    options: {
      baseSeq?: number;
      ts?: string;
      sessionId?: string;
      trustedImport?: boolean;
      authorize?: () => void;
    } = {},
  ): { event: Event; duplicate: boolean } {
    if (!this.hasProject(projectId)) throw new UnknownProjectError(projectId);
    this.database.exec("BEGIN IMMEDIATE");
    let result: { event: Event; duplicate: boolean };
    try {
      result = this.appendWithinTransaction(projectId, input, options);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (!result.duplicate) this.events.emit("event", result.event);
    return result;
  }

  private appendWithinTransaction(
    projectId: string,
    input: EventInput,
    options: {
      baseSeq?: number;
      ts?: string;
      sessionId?: string;
      trustedImport?: boolean;
      authorize?: () => void;
    } = {},
  ): { event: Event; duplicate: boolean } {
    const duplicate = this.database
      .prepare("SELECT * FROM events WHERE project_id = ? AND idem_key = ?")
      .get(projectId, input.idem_key) as EventRow | undefined;
    if (duplicate) return { event: decodeRow(duplicate), duplicate: true };
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
    options.authorize?.();
    reduceEvent(fold(this.listEvents(projectId)), event, {
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.trustedImport === true ? { replay: true } : {}),
    });
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
    return { event, duplicate: false };
  }

  appendBatch(
    projectId: string,
    inputs: readonly EventInput[],
    idemKey: string,
    options: { baseSeq?: number; ts?: string; sessionId?: string; authorize?: () => void } = {},
  ): { events: Event[]; duplicate: boolean } {
    if (!this.hasProject(projectId)) throw new UnknownProjectError(projectId);
    if (inputs.length === 0) throw new EventValidationError("batch must not be empty");
    this.database.exec("BEGIN IMMEDIATE");
    let result: { events: Event[]; duplicate: boolean };
    try {
      const duplicate = this.database
        .prepare("SELECT seqs_json FROM mutation_batches WHERE project_id = ? AND idem_key = ?")
        .get(projectId, idemKey) as { seqs_json: string } | undefined;
      if (duplicate) {
        const seqs = new Set(JSON.parse(duplicate.seqs_json) as number[]);
        result = {
          events: this.listEvents(projectId).filter((event) => seqs.has(event.seq)),
          duplicate: true,
        };
      } else {
        const currentSeq = this.latestSeq(projectId);
        if (options.baseSeq !== undefined && options.baseSeq !== currentSeq) {
          throw new StaleSequenceError(currentSeq);
        }
        const timestamp = options.ts ?? new Date().toISOString();
        const batchHash = createHash("sha256").update(idemKey).digest("hex");
        options.authorize?.();
        let state = fold(this.listEvents(projectId));
        const events: Event[] = [];
        for (const [index, input] of inputs.entries()) {
          const event = {
            seq: currentSeq + index + 1,
            project_id: projectId,
            ts: timestamp,
            ...input,
            idem_key: `batch:${batchHash}:${index}`,
          } as Event;
          state = reduceEvent(state, event, {
            ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          });
          events.push(event);
        }
        for (const event of events) {
          const { nodeRef, edgeRef } = refs(event as EventInput);
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
        }
        this.database
          .prepare("INSERT INTO mutation_batches (project_id, idem_key, seqs_json) VALUES (?, ?, ?)")
          .run(projectId, idemKey, JSON.stringify(events.map((event) => event.seq)));
        result = { events, duplicate: false };
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (!result.duplicate) {
      for (const event of result.events) this.events.emit("event", event);
    }
    return result;
  }
}
