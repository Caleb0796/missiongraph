import { randomUUID } from "node:crypto";
import { mkdir, open as openFile, readFile, readdir, rename, unlink } from "node:fs/promises";
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

export interface PendingAction {
  id: string;
  action: SupervisorAction;
  source: string;
  attempts: number;
  next_attempt_at?: string;
  permanent_failure?: string;
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
  workers: Record<string, WorkerState>;
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
  try {
    await writeExclusive(takeoverPath, contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`bridge state lock ${path} has a stale-lock takeover in progress`);
    }
    throw error;
  }
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
    (parsed.recovery_note !== undefined && typeof parsed.recovery_note !== "string")
  ) {
    throw new Error(`state does not match project ${projectId}`);
  }
  for (const worker of Object.values(parsed.workers)) {
    if (
      typeof worker !== "object" ||
      worker === null ||
      typeof worker.worktree !== "string" ||
      typeof worker.branch !== "string"
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
  return parsed as BridgeState;
}

export class StateStore {
  state: BridgeState;
  readonly existed: boolean;
  readonly recoveryMessage?: string;
  private pendingSave: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly lockPath: string,
    private readonly lockContents: string,
    state: BridgeState,
    existed: boolean,
    recoveryMessage?: string,
  ) {
    this.state = state;
    this.existed = existed;
    if (recoveryMessage) this.recoveryMessage = recoveryMessage;
  }

  static async open(
    path: string,
    projectId: string,
    processStartTime: ProcessStartTimeLookup = readProcessStartTime,
  ): Promise<StateStore> {
    await mkdir(dirname(path), { recursive: true });
    const lockPath = `${path}.lock`;
    const lockContents = await acquireLock(lockPath, processStartTime);
    try {
      await cleanTemporaries(path);
      try {
        const parsed = stateValue(JSON.parse(await readFile(path, "utf8")), projectId);
        return new StateStore(path, lockPath, lockContents, parsed, true, parsed.recovery_note);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return new StateStore(
            path,
            lockPath,
            lockContents,
            { v: 1, project_id: projectId, cursor: "0", pending_actions: [], workers: {} },
            false,
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
          workers: {},
        };
        return new StateStore(
          path,
          lockPath,
          lockContents,
          state,
          false,
          recoveryMessage,
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

  async close(): Promise<void> {
    if (this.closed) return;
    await this.pendingSave.catch(() => undefined);
    this.closed = true;
    if (await readFile(this.lockPath, "utf8").catch(() => "") !== this.lockContents) return;
    await unlink(this.lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
