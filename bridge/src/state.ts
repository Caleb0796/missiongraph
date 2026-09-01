import { randomUUID } from "node:crypto";
import { mkdir, open as openFile, readFile, readdir, rename, unlink, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { supervisorAction } from "./decision.js";
import {
  identifyProcess,
  processMatches,
  readProcessStartTime,
  type ProcessIdentity,
  type ProcessStartTimeLookup,
} from "./process.js";
import type { SupervisorAction } from "./types.js";

const lockHeartbeatIntervalMs = 60_000;

export interface PendingAction {
  id: string;
  action: SupervisorAction;
  source: string;
  attempts: number;
  next_attempt_at?: string;
  permanent_failure?: string;
}

export interface DeadLetter extends PendingAction {
  permanent_failure: string;
  failure_journal_error: string;
  dead_lettered_at: string;
}

export interface WorkerState {
  status: "spawning" | "live" | "idle" | "dead";
  thread_id?: string;
  worktree: string;
  branch: string;
  reporter_credential?: string;
  reporter_expires?: string;
  reporter_config_path?: string;
  pid?: number;
  process_start_time?: string;
  node_id?: string;
  project_id?: string;
  fleet_request_id?: string;
}

export interface FleetAdoptionState {
  request_id: string;
  project_id: string;
  node_id: string;
  node: {
    title: string;
    brief: string;
    estimate: number;
  };
  visitor_token: string;
  worker_key: string;
  status: "adopted" | "running" | "completing" | "completed" | "abandoned";
  adopted_at: string;
  started_at?: string;
  heartbeat_at?: string;
  outcome?: "done" | "failed";
  note?: string;
  finished_at?: string;
}

export interface BridgeState {
  v: 1;
  project_id: string;
  cursor: string;
  supervisor_thread_id?: string;
  supervisor_pid?: number;
  supervisor_process_start_time?: string;
  recovery_note?: string;
  pending_actions: PendingAction[];
  dead_letters: DeadLetter[];
  workers: Record<string, WorkerState>;
  fleet_adoption?: FleetAdoptionState;
}

interface LockRecord extends ProcessIdentity {
  hostname: string;
  owner_id: string;
}

function lockRecord(value: string): LockRecord | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<LockRecord>;
    if (
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) <= 0 ||
      typeof parsed.starttime !== "string" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.owner_id !== "string"
    ) return undefined;
    return parsed as LockRecord;
  } catch {
    return undefined;
  }
}

async function writeExclusive(path: string, contents: string): Promise<void> {
  const handle = await openFile(path, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function claimTakeover(
  path: string,
  contents: string,
  record: LockRecord,
  lookup: ProcessStartTimeLookup,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeExclusive(path, contents);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt > 0) throw new Error(`bridge state lock ${path} has a stale-lock takeover in progress`);
    }

    const observed = await readFile(path, "utf8").catch(() => "");
    const owner = lockRecord(observed);
    if (owner?.hostname !== hostname()) {
      throw new Error(`bridge state lock ${path} has a stale-lock takeover in progress`);
    }
    if (await processMatches(owner, lookup)) {
      throw new Error(`bridge state lock ${path} has a stale-lock takeover in progress`);
    }
    const orphanPath = `${path}.orphan-${Date.now()}-${record.owner_id}`;
    try {
      await rename(path, orphanPath);
      await unlink(orphanPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`bridge state lock ${path} has a stale-lock takeover in progress`);
}

async function acquireLock(path: string, lookup: ProcessStartTimeLookup): Promise<string> {
  const identity = await identifyProcess(process.pid, lookup);
  const record: LockRecord = { ...identity, hostname: hostname(), owner_id: randomUUID() };
  const contents = `${JSON.stringify(record)}\n`;
  try {
    await writeExclusive(path, contents);
    return contents;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const observed = await readFile(path, "utf8").catch(() => "");
  const existing = lockRecord(observed);
  if (existing) {
    if (existing.hostname !== hostname()) {
      throw new Error(`bridge state lock ${path} is held on host ${existing.hostname}`);
    }
    if (await processMatches(existing, lookup)) {
      throw new Error(`bridge state lock ${path} is held by live pid ${existing.pid}`);
    }
  }

  const takeoverPath = `${path}.takeover`;
  await claimTakeover(takeoverPath, contents, record, lookup);
  const stalePath = `${path}.stale-${Date.now()}-${record.owner_id}`;
  try {
    if (await readFile(path, "utf8").catch(() => "") !== observed) {
      throw new Error(`bridge state lock ${path} changed during stale-lock takeover`);
    }
    await rename(path, stalePath);
    await writeExclusive(path, contents);
    await unlink(stalePath);
    return contents;
  } finally {
    await unlink(takeoverPath).catch(() => undefined);
  }
}

async function cleanTemporaries(path: string): Promise<void> {
  const directory = dirname(path);
  const prefix = `${basename(path)}.`;
  for (const name of await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    if (name.startsWith(prefix) && name.endsWith(".tmp")) await unlink(join(directory, name));
  }
}

function stateValue(value: unknown, projectId: string): BridgeState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("state is not an object");
  const parsed = value as Partial<BridgeState>;
  if (
    parsed.v !== 1 ||
    parsed.project_id !== projectId ||
    typeof parsed.cursor !== "string" ||
    !/^\d+$/.test(parsed.cursor) ||
    typeof parsed.workers !== "object" ||
    parsed.workers === null ||
    Array.isArray(parsed.workers) ||
    (parsed.supervisor_thread_id !== undefined && typeof parsed.supervisor_thread_id !== "string") ||
    (parsed.supervisor_pid !== undefined && (!Number.isSafeInteger(parsed.supervisor_pid) || parsed.supervisor_pid <= 0)) ||
    (parsed.supervisor_process_start_time !== undefined && typeof parsed.supervisor_process_start_time !== "string") ||
    (parsed.recovery_note !== undefined && typeof parsed.recovery_note !== "string") ||
    (parsed.fleet_adoption !== undefined && !fleetAdoptionValue(parsed.fleet_adoption))
  ) {
    throw new Error(`state does not match project ${projectId}`);
  }
  for (const worker of Object.values(parsed.workers)) {
    if (
      typeof worker !== "object" ||
      worker === null ||
      typeof worker.worktree !== "string" ||
      typeof worker.branch !== "string" ||
      (worker.node_id !== undefined && typeof worker.node_id !== "string") ||
      (worker.project_id !== undefined && typeof worker.project_id !== "string") ||
      (worker.fleet_request_id !== undefined && typeof worker.fleet_request_id !== "string")
    ) {
      throw new Error("worker state is invalid");
    }
    if (!worker.status) worker.status = worker.pid ? "live" : "dead";
    if (!(worker.status === "spawning" || worker.status === "live" || worker.status === "idle" || worker.status === "dead")) {
      throw new Error("worker state has an invalid status");
    }
    if (
      (worker.pid !== undefined && (!Number.isSafeInteger(worker.pid) || worker.pid <= 0)) ||
      (worker.process_start_time !== undefined && typeof worker.process_start_time !== "string")
    ) throw new Error("worker process identity is invalid");
  }
  if (parsed.pending_actions === undefined) parsed.pending_actions = [];
  if (!Array.isArray(parsed.pending_actions)) throw new Error("pending action ledger is invalid");
  for (const pending of parsed.pending_actions) {
    if (
      typeof pending !== "object" ||
      pending === null ||
      typeof pending.id !== "string" ||
      typeof pending.source !== "string" ||
      !Number.isSafeInteger(pending.attempts) ||
      pending.attempts < 0 ||
      !supervisorAction(pending.action) ||
      (pending.next_attempt_at !== undefined && !Number.isFinite(Date.parse(pending.next_attempt_at))) ||
      (pending.permanent_failure !== undefined && typeof pending.permanent_failure !== "string")
    ) throw new Error("pending action ledger entry is invalid");
  }
  if (parsed.dead_letters === undefined) parsed.dead_letters = [];
  if (!Array.isArray(parsed.dead_letters)) throw new Error("dead letter ledger is invalid");
  for (const deadLetter of parsed.dead_letters) {
    if (
      typeof deadLetter !== "object" ||
      deadLetter === null ||
      typeof deadLetter.id !== "string" ||
      typeof deadLetter.source !== "string" ||
      !Number.isSafeInteger(deadLetter.attempts) ||
      deadLetter.attempts < 0 ||
      !supervisorAction(deadLetter.action) ||
      typeof deadLetter.permanent_failure !== "string" ||
      typeof deadLetter.failure_journal_error !== "string" ||
      !Number.isFinite(Date.parse(deadLetter.dead_lettered_at))
    ) throw new Error("dead letter ledger entry is invalid");
  }
  return parsed as BridgeState;
}

function fleetAdoptionValue(value: unknown): value is FleetAdoptionState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const adoption = value as Partial<FleetAdoptionState>;
  const node = adoption.node as Partial<FleetAdoptionState["node"]> | undefined;
  return (
    typeof adoption.request_id === "string" &&
    typeof adoption.project_id === "string" &&
    typeof adoption.node_id === "string" &&
    typeof adoption.visitor_token === "string" &&
    typeof adoption.worker_key === "string" &&
    ["adopted", "running", "completing", "completed", "abandoned"].includes(adoption.status ?? "") &&
    Number.isFinite(Date.parse(adoption.adopted_at ?? "")) &&
    (adoption.started_at === undefined || Number.isFinite(Date.parse(adoption.started_at))) &&
    (adoption.heartbeat_at === undefined || Number.isFinite(Date.parse(adoption.heartbeat_at))) &&
    (adoption.outcome === undefined || adoption.outcome === "done" || adoption.outcome === "failed") &&
    (adoption.note === undefined || typeof adoption.note === "string") &&
    (adoption.finished_at === undefined || Number.isFinite(Date.parse(adoption.finished_at))) &&
    typeof node === "object" &&
    node !== null &&
    typeof node.title === "string" &&
    typeof node.brief === "string" &&
    typeof node.estimate === "number" &&
    Number.isFinite(node.estimate)
  );
}

export class StateStore {
  state: BridgeState;
  readonly existed: boolean;
  readonly recoveryMessage?: string;
  private pendingSave: Promise<void> = Promise.resolve();
  private pendingHeartbeat: Promise<void> = Promise.resolve();
  private readonly heartbeatTimer: NodeJS.Timeout;
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly lockPath: string,
    private readonly lockContents: string,
    state: BridgeState,
    existed: boolean,
    recoveryMessage?: string,
    heartbeatIntervalMs = lockHeartbeatIntervalMs,
  ) {
    this.state = state;
    this.existed = existed;
    if (recoveryMessage) this.recoveryMessage = recoveryMessage;
    this.heartbeatTimer = setInterval(() => {
      const touch = async (): Promise<void> => this.touchLock();
      this.pendingHeartbeat = this.pendingHeartbeat.then(touch, touch);
      void this.pendingHeartbeat.catch(() => undefined);
    }, heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  static async open(
    path: string,
    projectId: string,
    processStartTime: ProcessStartTimeLookup = readProcessStartTime,
    heartbeatIntervalMs = lockHeartbeatIntervalMs,
  ): Promise<StateStore> {
    await mkdir(dirname(path), { recursive: true });
    const lockPath = `${path}.lock`;
    const lockContents = await acquireLock(lockPath, processStartTime);
    try {
      await cleanTemporaries(path);
      try {
        const parsed = stateValue(JSON.parse(await readFile(path, "utf8")), projectId);
        return new StateStore(path, lockPath, lockContents, parsed, true, parsed.recovery_note, heartbeatIntervalMs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return new StateStore(
            path,
            lockPath,
            lockContents,
            { v: 1, project_id: projectId, cursor: "0", pending_actions: [], dead_letters: [], workers: {} },
            false,
            undefined,
            heartbeatIntervalMs,
          );
        }
        const backup = `${path}.corrupt-${Date.now()}`;
        await rename(path, backup);
        const recoveryMessage = `Recovered corrupt bridge state by moving it to ${backup} and starting from cursor 0.`;
        const state: BridgeState = {
          v: 1,
          project_id: projectId,
          cursor: "0",
          recovery_note: recoveryMessage,
          pending_actions: [],
          dead_letters: [],
          workers: {},
        };
        return new StateStore(
          path,
          lockPath,
          lockContents,
          state,
          false,
          recoveryMessage,
          heartbeatIntervalMs,
        );
      }
    } catch (error) {
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
  }

  async save(): Promise<void> {
    const write = async (): Promise<void> => {
      if (this.closed) throw new Error("bridge state store is closed");
      const temporary = `${this.path}.${process.pid}.tmp`;
      const handle = await openFile(temporary, "w", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(this.state, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
      const directory = await openFile(dirname(this.path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
    this.pendingSave = this.pendingSave.then(write, write);
    await this.pendingSave;
  }

  private async touchLock(): Promise<void> {
    if (this.closed) return;
    if (await readFile(this.lockPath, "utf8").catch(() => "") !== this.lockContents) return;
    const now = new Date();
    await utimes(this.lockPath, now, now).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    clearInterval(this.heartbeatTimer);
    await this.pendingSave.catch(() => undefined);
    this.closed = true;
    await this.pendingHeartbeat.catch(() => undefined);
    if (await readFile(this.lockPath, "utf8").catch(() => "") !== this.lockContents) return;
    await unlink(this.lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
