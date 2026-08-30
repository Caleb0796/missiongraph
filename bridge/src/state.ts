import { mkdir, open as openFile, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface WorkerState {
  status: "spawning" | "live" | "dead";
  thread_id?: string;
  worktree: string;
  branch: string;
  reporter_credential?: string;
  reporter_expires?: string;
  reporter_config_path?: string;
  pid?: number;
}

export interface BridgeState {
  v: 1;
  project_id: string;
  cursor: string;
  supervisor_thread_id?: string;
  recovery_note?: string;
  workers: Record<string, WorkerState>;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireLock(path: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await openFile(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);
      if (Number.isSafeInteger(existing) && existing > 0 && processIsAlive(existing)) {
        throw new Error(`bridge state lock ${path} is held by live pid ${existing}`);
      }
      await unlink(path).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
    }
  }
  throw new Error(`could not acquire bridge state lock ${path}`);
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
    if (!(worker.status === "spawning" || worker.status === "live" || worker.status === "dead")) {
      throw new Error("worker state has an invalid status");
    }
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
    state: BridgeState,
    existed: boolean,
    recoveryMessage?: string,
  ) {
    this.state = state;
    this.existed = existed;
    if (recoveryMessage) this.recoveryMessage = recoveryMessage;
  }

  static async open(path: string, projectId: string): Promise<StateStore> {
    await mkdir(dirname(path), { recursive: true });
    const lockPath = `${path}.lock`;
    await acquireLock(lockPath);
    try {
      await cleanTemporaries(path);
      try {
        const parsed = stateValue(JSON.parse(await readFile(path, "utf8")), projectId);
        return new StateStore(path, lockPath, parsed, true, parsed.recovery_note);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return new StateStore(path, lockPath, { v: 1, project_id: projectId, cursor: "0", workers: {} }, false);
        }
        const backup = `${path}.corrupt-${Date.now()}`;
        await rename(path, backup);
        const recoveryMessage = `Recovered corrupt bridge state by moving it to ${backup} and starting from cursor 0.`;
        const state: BridgeState = {
          v: 1,
          project_id: projectId,
          cursor: "0",
          recovery_note: recoveryMessage,
          workers: {},
        };
        return new StateStore(
          path,
          lockPath,
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
    await unlink(this.lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
