import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface WorkerState {
  thread_id: string;
  worktree: string;
  branch: string;
  pid?: number;
}

export interface BridgeState {
  v: 1;
  project_id: string;
  cursor: string;
  supervisor_thread_id?: string;
  workers: Record<string, WorkerState>;
}

export class StateStore {
  state: BridgeState;
  readonly existed: boolean;
  private pendingSave: Promise<void> = Promise.resolve();

  private constructor(readonly path: string, state: BridgeState, existed: boolean) {
    this.state = state;
    this.existed = existed;
  }

  static async open(path: string, projectId: string): Promise<StateStore> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as BridgeState;
      if (parsed.v !== 1 || parsed.project_id !== projectId || !/^\d+$/.test(parsed.cursor)) {
        throw new Error(`bridge state at ${path} does not match project ${projectId}`);
      }
      for (const worker of Object.values(parsed.workers)) delete worker.pid;
      return new StateStore(path, parsed, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new StateStore(path, { v: 1, project_id: projectId, cursor: "0", workers: {} }, false);
    }
  }

  async save(): Promise<void> {
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    };
    this.pendingSave = this.pendingSave.then(write, write);
    await this.pendingSave;
  }
}
