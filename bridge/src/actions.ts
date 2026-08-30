import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { RunningCodex } from "./codex.js";
import type { BridgeConfig } from "./config.js";
import {
  processMatches,
  readProcessStartTime,
  terminateProcess,
  type ProcessIdentity,
  type ProcessStartTimeLookup,
} from "./process.js";
import { workerBrief } from "./prompts.js";
import { ReporterClient, reporterPayload } from "./reporter.js";
import type { PendingAction, StateStore, WorkerState } from "./state.js";
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

const reporterRenewalLeadMs = 5 * 60_000;
const reporterRenewalRetryMs = 5_000;
const maximumTimerDelayMs = 2_147_483_647;
const actionRetryDelaysMs = [100, 500];

interface WorkerCodexClient {
  startWorker(nodeId: string, brief: string, worktree: string, reporterConfigPath: string): RunningCodex;
  resumeWorker(
    nodeId: string,
    threadId: string,
    message: string,
    worktree: string,
    reporterConfigPath: string,
  ): RunningCodex;
}

function actionName(action: SupervisorAction): string {
  return action.act === "note" ? "note" : `${action.act} for node ${action.node_id}`;
}

function workerIdentity(worker: WorkerState): ProcessIdentity | undefined {
  return worker.pid && worker.process_start_time
    ? { pid: worker.pid, starttime: worker.process_start_time }
    : undefined;
}

export class ActionExecutor {
  private readonly running = new Map<string, RunningCodex>();
  private readonly renewalTimers = new Map<string, NodeJS.Timeout>();
  private readonly cleanupTasks = new Set<Promise<void>>();
  private readonly reporter: ReporterClient;
  private pendingTimer: NodeJS.Timeout | undefined;
  private pendingDrain: Promise<void> = Promise.resolve();
  private stopping = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly stateStore: StateStore,
    private readonly codex: WorkerCodexClient,
    private readonly logger: Logger,
    dryRun = false,
    private readonly processStartTime: ProcessStartTimeLookup = readProcessStartTime,
  ) {
    this.reporter = new ReporterClient(config, dryRun);
  }

  async initialize(): Promise<void> {
    const recovered: SupervisorAction[] = [];
    let changed = false;
    for (const [nodeId, worker] of Object.entries(this.stateStore.state.workers)) {
      const identity = workerIdentity(worker);
      if (worker.status === "idle" || worker.status === "dead") {
        if (worker.pid !== undefined || worker.process_start_time !== undefined) {
          delete worker.pid;
          delete worker.process_start_time;
          changed = true;
        }
        continue;
      }
      if (!identity || !await processMatches(identity, this.processStartTime)) {
        worker.status = "dead";
        delete worker.pid;
        delete worker.process_start_time;
        changed = true;
        recovered.push({
          act: "note",
          text: `Startup reconciliation marked worker ${nodeId} dead because its persisted process identity is missing or no longer matches. The thread id was retained for a later rebrief resume attempt.`,
        });
      } else if (worker.status === "spawning") {
        await terminateProcess(identity, { lookup: this.processStartTime });
        worker.status = "dead";
        delete worker.pid;
        delete worker.process_start_time;
        changed = true;
        recovered.push({
          act: "note",
          text: `Startup reconciliation terminated spawning worker ${nodeId} after matching its persisted process identity; a ledger retry may respawn it safely.`,
        });
      } else if (worker.status === "live") {
        this.scheduleRenewal(nodeId, worker.reporter_expires);
      }
    }
    if (changed) await this.stateStore.save();
    if (recovered.length > 0) await this.record({ actions: recovered }, "startup reconciliation");
    await this.drainPending();
  }

  async record(decision: SupervisorDecision, source: string): Promise<void> {
    let changed = false;
    for (const [index, action] of decision.actions.entries()) {
      const id = createHash("sha256")
        .update(this.config.projectId)
        .update("\0")
        .update(source)
        .update("\0")
        .update(String(index))
        .update("\0")
        .update(JSON.stringify(action))
        .digest("hex");
      if (this.stateStore.state.pending_actions.some((pending) => pending.id === id)) continue;
      this.stateStore.state.pending_actions.push({
        id,
        action,
        source,
        attempts: 0,
      });
      changed = true;
    }
    if (changed) await this.stateStore.save();
  }

  async execute(decision: SupervisorDecision, source = `direct supervisor decision ${randomUUID()}`): Promise<void> {
    await this.record(decision, source);
    await this.drainPending();
  }

  async drainPending(): Promise<void> {
    const drain = async (): Promise<void> => this.drainPendingOnce();
    this.pendingDrain = this.pendingDrain.then(drain, drain);
    await this.pendingDrain;
  }

  async journal(text: string, idemKey?: string): Promise<void> {
    await this.reporter.post(reporterPayload("supervisor", "JOURNAL_NOTE", { text }, idemKey));
  }

  async stop(): Promise<void> {
    this.beginShutdown();
    await this.pendingDrain.catch(() => undefined);
    await Promise.allSettled(this.cleanupTasks);
  }

  beginShutdown(): void {
    this.stopping = true;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
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

  private async drainPendingOnce(): Promise<void> {
    if (this.stopping) return;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    while (!this.stopping) {
      const pending = this.stateStore.state.pending_actions[0];
      if (!pending) return;
      const nextAttempt = Date.parse(pending.next_attempt_at ?? "");
      if (Number.isFinite(nextAttempt) && nextAttempt > Date.now()) {
        this.schedulePendingDrain(nextAttempt - Date.now());
        return;
      }
      if (pending.permanent_failure) {
        try {
          await this.journal(
            `Mechanical action permanently failed after 3 attempts (${pending.source}): ${pending.permanent_failure}. Action payload: ${JSON.stringify(pending.action)}`,
            `${pending.id}:permanent-failure`,
          );
          await this.removePending(pending.id);
          continue;
        } catch (error) {
          this.logger.error(`failed to journal permanent action failure: ${error instanceof Error ? error.message : String(error)}`);
          const delay = actionRetryDelaysMs.at(-1)!;
          pending.next_attempt_at = new Date(Date.now() + delay).toISOString();
          try {
            await this.stateStore.save();
          } finally {
            this.schedulePendingDrain(delay);
          }
          return;
        }
      }
      try {
        await this.executeOne(pending);
        await this.removePending(pending.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pending.attempts += 1;
        this.logger.error(`${actionName(pending.action)} attempt ${pending.attempts} failed: ${message}`);
        if (pending.attempts >= 3) {
          pending.permanent_failure = message;
          delete pending.next_attempt_at;
          try {
            await this.stateStore.save();
          } catch (saveError) {
            this.schedulePendingDrain(actionRetryDelaysMs.at(-1)!);
            throw saveError;
          }
          continue;
        }
        const delay = actionRetryDelaysMs[pending.attempts - 1]!;
        pending.next_attempt_at = new Date(Date.now() + delay).toISOString();
        try {
          await this.stateStore.save();
        } finally {
          this.schedulePendingDrain(delay);
        }
        return;
      }
    }
  }

  private schedulePendingDrain(delayMs: number): void {
    if (this.stopping) return;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    const timer = setTimeout(() => {
      this.pendingTimer = undefined;
      if (!this.stopping) void this.drainPending();
    }, Math.max(0, Math.min(delayMs, maximumTimerDelayMs)));
    timer.unref();
    this.pendingTimer = timer;
  }

  private async removePending(id: string): Promise<void> {
    const index = this.stateStore.state.pending_actions.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    this.stateStore.state.pending_actions.splice(index, 1);
    await this.stateStore.save();
  }

  private async executeOne(pending: PendingAction): Promise<void> {
    const action = pending.action;
    switch (action.act) {
      case "spawn_worker":
        await this.spawnWorker(action.node_id, action.brief, pending.id);
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
        await this.journal(action.text, pending.id);
    }
  }

  private async spawnWorker(nodeId: string, brief: string, pendingId: string): Promise<void> {
    const previous = this.stateStore.state.workers[nodeId];
    if (previous && previous.status !== "dead") {
      const note = `spawn_worker for node ${nodeId} was an idempotent no-op because a ${previous.status} worker entry already exists.`;
      this.logger.warn(note);
      await this.journal(note, `${pendingId}:spawn-noop`);
      return;
    }
    if (previous?.status === "dead") {
      await this.journal(`Respawning dead worker for node ${nodeId} in a fresh worktree.`, `${pendingId}:respawn`);
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
      const identity = await running.identity;
      state.pid = identity.pid;
      state.process_start_time = identity.starttime;
      await this.stateStore.save();
      state.thread_id = await running.threadId;
      state.status = "live";
      await this.stateStore.save();
    } catch (error) {
      state.status = "dead";
      delete state.pid;
      delete state.process_start_time;
      this.running.delete(nodeId);
      await this.stateStore.save();
      throw error;
    }
    this.scheduleRenewal(nodeId, credential.expires);
    this.logger.info(`spawned worker ${nodeId} as thread ${state.thread_id} in ${worktree}`);
    this.trackInitialCompletion(nodeId, running);
  }

  private trackInitialCompletion(nodeId: string, running: RunningCodex): void {
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
          current.status = current.thread_id ? "idle" : "dead";
          delete current.pid;
          delete current.process_start_time;
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
    if (!worker || !worker.thread_id || worker.status === "spawning") {
      this.logger.warn(`worker action ignored because node ${nodeId} has no resumable tracked thread`);
      return;
    }
    await this.ensureCredential(nodeId, worker);
    if (this.stopping) throw new Error("bridge is shutting down");
    const reporterConfigPath = worker.reporter_config_path ?? `${worker.worktree}.reporter.conf`;
    const running = this.codex.resumeWorker(
      nodeId,
      worker.thread_id,
      message,
      worker.worktree,
      reporterConfigPath,
    );
    this.running.set(nodeId, running);
    try {
      const identity = await running.identity;
      worker.pid = identity.pid;
      worker.process_start_time = identity.starttime;
      worker.status = "live";
      await this.stateStore.save();
      await running.threadId;
      await running.completed;
    } finally {
      if (this.running.get(nodeId) === running) {
        this.running.delete(nodeId);
        worker.status = "idle";
        delete worker.pid;
        delete worker.process_start_time;
        this.clearRenewal(nodeId);
        await this.stateStore.save();
      }
    }
  }

  private async ensureCredential(nodeId: string, worker: WorkerState): Promise<void> {
    const reporterExpires = Date.parse(worker.reporter_expires ?? "");
    if (
      !worker.reporter_credential ||
      !Number.isFinite(reporterExpires) ||
      reporterExpires - Date.now() < reporterRenewalLeadMs
    ) {
      const credential = await this.reporter.issue(`worker:${nodeId}`);
      if (this.stopping) throw new Error("bridge is shutting down");
      worker.reporter_credential = credential.token;
      worker.reporter_expires = credential.expires;
      this.logger.info(`renewed reporter credential for worker ${nodeId} through ${credential.expires}`);
    }
    const reporterConfigPath = worker.reporter_config_path ?? `${worker.worktree}.reporter.conf`;
    await writeReporterConfig(reporterConfigPath, worker.reporter_credential);
    if (this.stopping) throw new Error("bridge is shutting down");
    worker.reporter_config_path = reporterConfigPath;
    await this.stateStore.save();
    if (this.stopping) throw new Error("bridge is shutting down");
  }

  private scheduleRenewal(nodeId: string, expires: string | undefined): void {
    this.clearRenewal(nodeId);
    if (this.stopping) return;
    const expiry = Date.parse(expires ?? "");
    const delay = Number.isFinite(expiry) ? Math.max(0, expiry - Date.now() - reporterRenewalLeadMs) : 0;
    const timer = setTimeout(() => {
      if (this.stopping) return;
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
    if (this.stopping) return;
    const worker = this.stateStore.state.workers[nodeId];
    if (!worker || worker.status !== "live") return;
    try {
      const credential = await this.reporter.issue(`worker:${nodeId}`);
      if (this.stopping || worker.status !== "live") return;
      const reporterConfigPath = worker.reporter_config_path ?? `${worker.worktree}.reporter.conf`;
      await writeReporterConfig(reporterConfigPath, credential.token);
      if (this.stopping || worker.status !== "live") return;
      worker.reporter_credential = credential.token;
      worker.reporter_expires = credential.expires;
      worker.reporter_config_path = reporterConfigPath;
      await this.stateStore.save();
      if (this.stopping || worker.status !== "live") return;
      this.logger.info(`renewed reporter credential for live worker ${nodeId} through ${credential.expires}`);
      this.scheduleRenewal(nodeId, credential.expires);
    } catch (error) {
      this.logger.error(
        `reporter credential renewal failed for worker ${nodeId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (this.stopping || worker.status !== "live") return;
      const timer = setTimeout(() => {
        if (!this.stopping) void this.renewLiveCredential(nodeId);
      }, reporterRenewalRetryMs);
      timer.unref();
      this.renewalTimers.set(nodeId, timer);
    }
  }

  private async killWorker(nodeId: string): Promise<void> {
    const worker = this.stateStore.state.workers[nodeId];
    if (!worker || worker.status === "dead") {
      this.logger.warn(`kill_worker ignored because node ${nodeId} has no tracked active process`);
      return;
    }
    const running = this.running.get(nodeId);
    if (running) {
      await running.terminate();
    } else {
      const identity = workerIdentity(worker);
      if (identity) await terminateProcess(identity, { lookup: this.processStartTime });
    }
    worker.status = worker.thread_id ? "idle" : "dead";
    delete worker.pid;
    delete worker.process_start_time;
    this.running.delete(nodeId);
    this.clearRenewal(nodeId);
    await this.stateStore.save();
  }
}
