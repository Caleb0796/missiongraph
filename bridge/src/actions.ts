import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { RunningCodex } from "./codex.js";
import type { BridgeConfig } from "./config.js";
import { workerBrief } from "./prompts.js";
import { ReporterClient, reporterPayload } from "./reporter.js";
import type { StateStore, WorkerState } from "./state.js";
import type { Logger, SupervisorAction, SupervisorDecision } from "./types.js";

async function runGit(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`));
    });
  });
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "node";
}

async function writeReporterConfig(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `header = "Authorization: Bearer ${token}"\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function processIsAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function terminatePid(pid: number): Promise<void> {
  if (!processIsAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && processIsAlive(pid)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
}

const reporterRenewalLeadMs = 5 * 60_000;
const reporterRenewalRetryMs = 5_000;
const maximumTimerDelayMs = 2_147_483_647;

interface WorkerCodexClient {
  startWorker(nodeId: string, brief: string, worktree: string, reporterConfigPath: string): RunningCodex;
  resumeWorker(
    nodeId: string,
    threadId: string,
    message: string,
    worktree: string,
    reporterConfigPath: string,
  ): Promise<unknown>;
}

function actionName(action: SupervisorAction): string {
  return action.act === "note" ? "note" : `${action.act} for node ${action.node_id}`;
}

export class ActionExecutor {
  private readonly running = new Map<string, RunningCodex>();
  private readonly renewalTimers = new Map<string, NodeJS.Timeout>();
  private readonly cleanupTasks = new Set<Promise<void>>();
  private readonly reporter: ReporterClient;
  private stopping = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly stateStore: StateStore,
    private readonly codex: WorkerCodexClient,
    private readonly logger: Logger,
    dryRun = false,
  ) {
    this.reporter = new ReporterClient(config, dryRun);
  }

  async initialize(): Promise<void> {
    const recovered: string[] = [];
    let changed = false;
    for (const [nodeId, worker] of Object.entries(this.stateStore.state.workers)) {
      if (worker.status === "dead") continue;
      if (!processIsAlive(worker.pid)) {
        worker.status = "dead";
        delete worker.pid;
        changed = true;
        recovered.push(`Startup reconciliation marked worker ${nodeId} dead because its persisted process is not running.`);
      } else if (worker.status === "live") {
        this.scheduleRenewal(nodeId, worker.reporter_expires);
      }
    }
    if (changed) await this.stateStore.save();
    for (const note of recovered) await this.journal(note);
  }

  async execute(decision: SupervisorDecision): Promise<void> {
    for (const action of decision.actions) {
      if (this.stopping) return;
      try {
        await this.executeOne(action);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`${action.act} failed: ${message}`);
        try {
          await this.journal(`Mechanical action ${actionName(action)} failed: ${message}`);
        } catch (journalError) {
          this.logger.error(`failed to journal ${action.act} failure: ${journalError instanceof Error ? journalError.message : String(journalError)}`);
        }
      }
    }
  }

  async journal(text: string): Promise<void> {
    await this.reporter.post(reporterPayload("supervisor", "JOURNAL_NOTE", { text }));
  }

  async stop(): Promise<void> {
    this.beginShutdown();
    await Promise.allSettled(this.cleanupTasks);
  }

  beginShutdown(): void {
    this.stopping = true;
    for (const timer of this.renewalTimers.values()) clearTimeout(timer);
    this.renewalTimers.clear();
  }

  async terminateAll(): Promise<void> {
    this.beginShutdown();
    const results = await Promise.allSettled(
      Object.keys(this.stateStore.state.workers).map((nodeId) => this.killWorker(nodeId)),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.error(`worker termination failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
  }

  private async executeOne(action: SupervisorAction): Promise<void> {
    switch (action.act) {
      case "spawn_worker":
        await this.spawnWorker(action.node_id, action.brief);
        return;
      case "rebrief_worker":
        await this.resumeWorker(action.node_id, action.message);
        return;
      case "pause_worker":
        await this.resumeWorker(action.node_id, "Pause cooperatively at the next safe point and report PAUSE_ACKED.");
        return;
      case "resume_worker":
        await this.resumeWorker(action.node_id, "Resume the assigned MissionGraph task and continue required reporting.");
        return;
      case "kill_worker":
        await this.killWorker(action.node_id);
        return;
      case "note":
        await this.journal(action.text);
    }
  }

  private async spawnWorker(nodeId: string, brief: string): Promise<void> {
    const previous = this.stateStore.state.workers[nodeId];
    if (previous && previous.status !== "dead") {
      const note = `spawn_worker for node ${nodeId} was an idempotent no-op because a ${previous.status} worker entry already exists.`;
      this.logger.warn(note);
      await this.journal(note);
      return;
    }
    if (previous?.status === "dead") {
      await this.journal(`Respawning dead worker for node ${nodeId} in a fresh worktree.`);
    }
    const suffix = randomUUID().slice(0, 8);
    const nodeSlug = slug(nodeId);
    const branch = `work/${nodeSlug}-${suffix}`;
    const root = join(dirname(this.config.targetRepoPath), ".missiongraph-worktrees");
    const worktree = join(root, `${basename(this.config.targetRepoPath)}-${nodeSlug}-${suffix}`);
    const reporterConfigPath = `${worktree}.reporter.conf`;
    const credential = await this.reporter.issue(`worker:${nodeId}`);
    await writeReporterConfig(reporterConfigPath, credential.token);
    await mkdir(root, { recursive: true });
    await runGit(["worktree", "add", worktree, "-b", branch], this.config.targetRepoPath);
    const state: WorkerState = {
      status: "spawning",
      worktree,
      branch,
      reporter_credential: credential.token,
      reporter_expires: credential.expires,
      reporter_config_path: reporterConfigPath,
    };
    this.stateStore.state.workers[nodeId] = state;
    await this.stateStore.save();

    let running: RunningCodex;
    try {
      running = this.codex.startWorker(
        nodeId,
        workerBrief(nodeId, brief, worktree),
        worktree,
        reporterConfigPath,
      );
      this.running.set(nodeId, running);
      if (running.pid > 0) state.pid = running.pid;
      await this.stateStore.save();
      state.thread_id = await running.threadId;
      state.status = "live";
      await this.stateStore.save();
    } catch (error) {
      state.status = "dead";
      delete state.pid;
      this.running.delete(nodeId);
      await this.stateStore.save();
      throw error;
    }
    this.scheduleRenewal(nodeId, credential.expires);
    this.logger.info(`spawned worker ${nodeId} as thread ${state.thread_id} in ${worktree}`);
    const cleanup = running.completed
      .catch((error: unknown) => {
        this.logger.error(`worker ${nodeId} process ended with error: ${error instanceof Error ? error.message : String(error)}`);
      })
      .then(async () => {
        if (this.running.get(nodeId) !== running) return;
        this.running.delete(nodeId);
        this.clearRenewal(nodeId);
        const current = this.stateStore.state.workers[nodeId];
        if (current) {
          current.status = "dead";
          delete current.pid;
          await this.stateStore.save();
        }
      })
      .catch((error: unknown) => {
        this.logger.error(`failed to persist worker ${nodeId} process exit: ${error instanceof Error ? error.message : String(error)}`);
      });
    this.cleanupTasks.add(cleanup);
    void cleanup.finally(() => this.cleanupTasks.delete(cleanup));
  }

  private async resumeWorker(nodeId: string, message: string): Promise<void> {
    const worker = this.stateStore.state.workers[nodeId];
    if (!worker || worker.status !== "live" || !worker.thread_id) {
      this.logger.warn(`worker action ignored because node ${nodeId} has no live tracked session`);
      return;
    }
    await this.ensureCredential(nodeId, worker);
    const reporterConfigPath = worker.reporter_config_path ?? `${worker.worktree}.reporter.conf`;
    await this.codex.resumeWorker(
      nodeId,
      worker.thread_id,
      message,
      worker.worktree,
      reporterConfigPath,
    );
    this.scheduleRenewal(nodeId, worker.reporter_expires);
  }

  private async ensureCredential(nodeId: string, worker: WorkerState): Promise<void> {
    const reporterExpires = Date.parse(worker.reporter_expires ?? "");
    if (
      !worker.reporter_credential ||
      !Number.isFinite(reporterExpires) ||
      reporterExpires - Date.now() < reporterRenewalLeadMs
    ) {
      const credential = await this.reporter.issue(`worker:${nodeId}`);
      worker.reporter_credential = credential.token;
      worker.reporter_expires = credential.expires;
      this.logger.info(`renewed reporter credential for worker ${nodeId} through ${credential.expires}`);
    }
    const reporterConfigPath = worker.reporter_config_path ?? `${worker.worktree}.reporter.conf`;
    await writeReporterConfig(reporterConfigPath, worker.reporter_credential);
    worker.reporter_config_path = reporterConfigPath;
    await this.stateStore.save();
  }

  private scheduleRenewal(nodeId: string, expires: string | undefined): void {
    this.clearRenewal(nodeId);
    const expiry = Date.parse(expires ?? "");
    const delay = Number.isFinite(expiry) ? Math.max(0, expiry - Date.now() - reporterRenewalLeadMs) : 0;
    const timer = setTimeout(() => {
      if (delay > maximumTimerDelayMs) this.scheduleRenewal(nodeId, expires);
      else void this.renewLiveCredential(nodeId);
    }, Math.min(delay, maximumTimerDelayMs));
    timer.unref();
    this.renewalTimers.set(nodeId, timer);
  }

  private clearRenewal(nodeId: string): void {
    const timer = this.renewalTimers.get(nodeId);
    if (timer) clearTimeout(timer);
    this.renewalTimers.delete(nodeId);
  }

  private async renewLiveCredential(nodeId: string): Promise<void> {
    const worker = this.stateStore.state.workers[nodeId];
    if (!worker || worker.status !== "live") return;
    try {
      const credential = await this.reporter.issue(`worker:${nodeId}`);
      if (worker.status !== "live") return;
      const reporterConfigPath = worker.reporter_config_path ?? `${worker.worktree}.reporter.conf`;
      await writeReporterConfig(reporterConfigPath, credential.token);
      worker.reporter_credential = credential.token;
      worker.reporter_expires = credential.expires;
      worker.reporter_config_path = reporterConfigPath;
      await this.stateStore.save();
      this.logger.info(`renewed reporter credential for live worker ${nodeId} through ${credential.expires}`);
      this.scheduleRenewal(nodeId, credential.expires);
    } catch (error) {
      this.logger.error(
        `reporter credential renewal failed for worker ${nodeId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (worker.status !== "live") return;
      const timer = setTimeout(() => {
        void this.renewLiveCredential(nodeId);
      }, reporterRenewalRetryMs);
      timer.unref();
      this.renewalTimers.set(nodeId, timer);
    }
  }

  private async killWorker(nodeId: string): Promise<void> {
    const worker = this.stateStore.state.workers[nodeId];
    if (!worker || worker.status === "dead") {
      this.logger.warn(`kill_worker ignored because node ${nodeId} has no live tracked session`);
      return;
    }
    const running = this.running.get(nodeId);
    if (running) await running.terminate();
    else if (worker.pid) await terminatePid(worker.pid);
    worker.status = "dead";
    delete worker.pid;
    this.running.delete(nodeId);
    this.clearRenewal(nodeId);
    await this.stateStore.save();
  }
}
