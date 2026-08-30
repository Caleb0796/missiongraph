import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";

import type { RunningCodex } from "./codex.js";
import type { BridgeConfig } from "./config.js";
import { workerBrief } from "./prompts.js";
import { ReporterClient, reporterPayload } from "./reporter.js";
import type { StateStore } from "./state.js";
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

const reporterRenewalLeadMs = 30_000;
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

export class ActionExecutor {
  private readonly running = new Map<string, RunningCodex>();
  private readonly renewalTimers = new Map<string, NodeJS.Timeout>();
  private readonly reporter: ReporterClient;

  constructor(
    private readonly config: BridgeConfig,
    private readonly stateStore: StateStore,
    private readonly codex: WorkerCodexClient,
    private readonly logger: Logger,
  ) {
    this.reporter = new ReporterClient(config);
  }

  async execute(decision: SupervisorDecision): Promise<void> {
    for (const action of decision.actions) {
      try {
        await this.executeOne(action);
      } catch (error) {
        this.logger.error(`${action.act} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  stop(): void {
    for (const timer of this.renewalTimers.values()) clearTimeout(timer);
    this.renewalTimers.clear();
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
        await this.reporter.post(reporterPayload("supervisor", "JOURNAL_NOTE", { text: action.text }));
    }
  }

  private async spawnWorker(nodeId: string, brief: string): Promise<void> {
    if (this.stateStore.state.workers[nodeId]) {
      this.logger.warn(`spawn_worker ignored because node ${nodeId} already has a worker session`);
      return;
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
    const running = this.codex.startWorker(
      nodeId,
      workerBrief(nodeId, brief, worktree),
      worktree,
      reporterConfigPath,
    );
    const threadId = await running.threadId;
    this.running.set(nodeId, running);
    this.stateStore.state.workers[nodeId] = {
      thread_id: threadId,
      worktree,
      branch,
      reporter_credential: credential.token,
      reporter_expires: credential.expires,
      reporter_config_path: reporterConfigPath,
      ...(running.pid > 0 ? { pid: running.pid } : {}),
    };
    await this.stateStore.save();
    this.scheduleRenewal(nodeId, running, credential.expires);
    this.logger.info(`spawned worker ${nodeId} as thread ${threadId} in ${worktree}`);
    void running.completed
      .catch((error: unknown) => {
        this.logger.error(`worker ${nodeId} process ended with error: ${error instanceof Error ? error.message : String(error)}`);
      })
      .then(async () => {
        if (this.running.get(nodeId) !== running) return;
        this.running.delete(nodeId);
        this.clearRenewal(nodeId);
        const state = this.stateStore.state.workers[nodeId];
        if (state) delete state.pid;
        await this.stateStore.save();
      });
  }

  private async resumeWorker(nodeId: string, message: string): Promise<void> {
    const worker = this.stateStore.state.workers[nodeId];
    if (!worker) {
      this.logger.warn(`worker action ignored because node ${nodeId} has no tracked session`);
      return;
    }
    const reporterExpires = Date.parse(worker.reporter_expires ?? "");
    if (
      !worker.reporter_credential ||
      !Number.isFinite(reporterExpires) ||
      reporterExpires <= Date.now()
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
    await this.codex.resumeWorker(
      nodeId,
      worker.thread_id,
      message,
      worker.worktree,
      reporterConfigPath,
    );
  }

  private scheduleRenewal(nodeId: string, running: RunningCodex, expires: string): void {
    this.clearRenewal(nodeId);
    const delay = Math.max(0, Date.parse(expires) - Date.now() - reporterRenewalLeadMs);
    const timer = setTimeout(() => {
      if (delay > maximumTimerDelayMs) this.scheduleRenewal(nodeId, running, expires);
      else void this.renewRunningCredential(nodeId, running);
    }, Math.min(delay, maximumTimerDelayMs));
    timer.unref();
    this.renewalTimers.set(nodeId, timer);
  }

  private clearRenewal(nodeId: string): void {
    const timer = this.renewalTimers.get(nodeId);
    if (timer) clearTimeout(timer);
    this.renewalTimers.delete(nodeId);
  }

  private async renewRunningCredential(nodeId: string, running: RunningCodex): Promise<void> {
    if (this.running.get(nodeId) !== running) return;
    try {
      const credential = await this.reporter.issue(`worker:${nodeId}`);
      if (this.running.get(nodeId) !== running) return;
      const worker = this.stateStore.state.workers[nodeId];
      if (!worker) return;
      const reporterConfigPath = worker.reporter_config_path ?? `${worker.worktree}.reporter.conf`;
      await writeReporterConfig(reporterConfigPath, credential.token);
      worker.reporter_credential = credential.token;
      worker.reporter_expires = credential.expires;
      worker.reporter_config_path = reporterConfigPath;
      await this.stateStore.save();
      this.logger.info(`renewed reporter credential for running worker ${nodeId} through ${credential.expires}`);
      this.scheduleRenewal(nodeId, running, credential.expires);
    } catch (error) {
      this.logger.error(
        `reporter credential renewal failed for worker ${nodeId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (this.running.get(nodeId) !== running) return;
      const timer = setTimeout(() => {
        void this.renewRunningCredential(nodeId, running);
      }, reporterRenewalRetryMs);
      timer.unref();
      this.renewalTimers.set(nodeId, timer);
    }
  }

  private async killWorker(nodeId: string): Promise<void> {
    try {
      await this.resumeWorker(nodeId, "Stop cooperatively at the next safe point, report final status, and exit.");
    } finally {
      this.running.get(nodeId)?.terminate();
    }
  }
}
