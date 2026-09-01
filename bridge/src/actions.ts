import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
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
import { adoptedWorkerBrief, workerBrief } from "./prompts.js";
import { ReporterClient, reporterPayload } from "./reporter.js";
import { ExecutionSlot, type ExecutionLease } from "./slot.js";
import type { PendingAction, StateStore, WorkerState } from "./state.js";
import type { Logger, SupervisorAction, SupervisorDecision } from "./types.js";

async function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, { cwd, signal, stdio: ["ignore", "ignore", "pipe"] });
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

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener("abort", abort));
  });
}

const reporterRenewalLeadMs = 5 * 60_000;
const reporterRenewalRetryMs = 5_000;
const maximumTimerDelayMs = 2_147_483_647;
const actionRetryDelaysMs = [100, 500];
const recoveredLookupRetryDelaysMs = [50, 100];
const maximumDeadLetters = 50;

interface WorkerCodexClient {
  startWorker(
    nodeId: string,
    brief: string,
    worktree: string,
    reporterConfigPath: string,
    workerConfig?: BridgeConfig,
  ): RunningCodex;
  resumeWorker(
    nodeId: string,
    threadId: string,
    message: string,
    worktree: string,
    reporterConfigPath: string,
  ): RunningCodex;
}

export interface FleetWorkerAssignment {
  requestId: string;
  projectId: string;
  nodeId: string;
  title: string;
  brief: string;
  workerKey: string;
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
  private readonly leases = new Map<string, ExecutionLease>();
  private readonly renewalTimers = new Map<string, NodeJS.Timeout>();
  private readonly cleanupTasks = new Set<Promise<void>>();
  private readonly reporter: ReporterClient;
  private pendingTimer: NodeJS.Timeout | undefined;
  private pendingDrain: Promise<void> = Promise.resolve();
  private readonly shutdown = new AbortController();
  private stopping = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly stateStore: StateStore,
    private readonly codex: WorkerCodexClient,
    private readonly logger: Logger,
    private readonly dryRun = false,
    private readonly processStartTime: ProcessStartTimeLookup = readProcessStartTime,
    private readonly slot = new ExecutionSlot(config.fleetMode),
  ) {
    this.reporter = new ReporterClient(config, dryRun);
  }

  async initialize(): Promise<void> {
    if (await access(this.config.targetRepoPath).then(() => true, () => false)) {
      await runGit(["worktree", "prune", "--expire", "now"], this.config.targetRepoPath);
    }
    const recovered: SupervisorAction[] = [];
    let changed = false;
    for (const [nodeId, worker] of Object.entries(this.stateStore.state.workers)) {
      const identity = workerIdentity(worker);
      if (worker.status === "idle" || worker.status === "dead") {
        if (worker.reporter_credential || worker.reporter_expires || worker.reporter_config_path) {
          await this.clearReporterCredential(worker);
          changed = true;
        }
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
        await this.clearReporterCredential(worker);
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
        await this.clearReporterCredential(worker);
        changed = true;
        recovered.push({
          act: "note",
          text: `Startup reconciliation terminated spawning worker ${nodeId} after matching its persisted process identity; a ledger retry may respawn it safely.`,
        });
      } else if (worker.status === "live") {
        const lease = this.slot.tryAcquire(`recovered worker ${nodeId}`);
        if (!lease) {
          await terminateProcess(identity, { lookup: this.processStartTime });
          worker.status = "dead";
          delete worker.pid;
          delete worker.process_start_time;
          await this.clearReporterCredential(worker);
          changed = true;
          recovered.push({
            act: "note",
            text: `Startup reconciliation terminated worker ${nodeId} because another process already occupied the single execution slot.`,
          });
        } else {
          this.leases.set(nodeId, lease);
          this.scheduleRenewal(nodeId, worker.reporter_expires);
          this.trackRecoveredCompletion(nodeId, identity, lease);
        }
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
    this.shutdown.abort(new Error("bridge is shutting down"));
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
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`failed to journal permanent action failure: ${message}`);
          await this.moveToDeadLetters(pending, message);
          continue;
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

  private async moveToDeadLetters(pending: PendingAction, journalError: string): Promise<void> {
    const index = this.stateStore.state.pending_actions.findIndex((entry) => entry.id === pending.id);
    if (index < 0 || !pending.permanent_failure) return;
    this.stateStore.state.pending_actions.splice(index, 1);
    this.stateStore.state.dead_letters.push({
      ...pending,
      permanent_failure: pending.permanent_failure,
      failure_journal_error: journalError,
      dead_lettered_at: new Date().toISOString(),
    });
    if (this.stateStore.state.dead_letters.length > maximumDeadLetters) {
      this.stateStore.state.dead_letters.splice(0, this.stateStore.state.dead_letters.length - maximumDeadLetters);
    }
    await this.stateStore.save();
  }

  private async executeOne(pending: PendingAction): Promise<void> {
    const action = pending.action;
    switch (action.act) {
      case "spawn_worker":
        await this.spawnWorker(action.node_id, action.brief, pending.id);
        return;
      case "rebrief_worker":
        await this.resumeWorker(action.node_id, action.message, pending.id, action.act);
        return;
      case "pause_worker":
        await this.resumeWorker(
          action.node_id,
          "Pause cooperatively at the next safe point and report PAUSE_ACKED.",
          pending.id,
          action.act,
        );
        return;
      case "resume_worker":
        await this.resumeWorker(
          action.node_id,
          "Resume the assigned MissionGraph task and continue required reporting.",
          pending.id,
          action.act,
        );
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
    const lease = await this.slot.acquire(`flagship worker ${nodeId}`);
    if (this.stopping) {
      lease.release();
      throw new Error("bridge is shutting down");
    }
    await this.launchWorker(
      {
        requestId: "",
        projectId: this.config.projectId,
        nodeId,
        title: "",
        brief,
        workerKey: nodeId,
      },
      lease,
      false,
    );
  }

  async spawnFleetWorker(
    assignment: FleetWorkerAssignment,
    lease: ExecutionLease,
    signal?: AbortSignal,
  ): Promise<RunningCodex> {
    const previous = this.stateStore.state.workers[assignment.workerKey];
    if (previous && previous.status !== "dead") {
      lease.release();
      throw new Error(`fleet worker ${assignment.workerKey} already has a ${previous.status} worker entry`);
    }
    return await this.launchWorker(assignment, lease, true, signal);
  }

  async killTrackedWorker(workerKey: string): Promise<void> {
    await this.killWorker(workerKey);
  }

  async clearTrackedReporter(workerKey: string): Promise<void> {
    const worker = this.stateStore.state.workers[workerKey];
    if (worker) await this.clearReporterCredential(worker);
  }

  async removeTrackedWorktree(workerKey: string): Promise<void> {
    const worker = this.stateStore.state.workers[workerKey];
    if (!worker) return;
    await runGit(["worktree", "remove", "--force", worker.worktree], this.config.targetRepoPath).catch((error: unknown) => {
      if (error instanceof Error && error.message.endsWith("is not a working tree")) return;
      throw error;
    });
  }

  private async launchWorker(
    assignment: FleetWorkerAssignment,
    lease: ExecutionLease,
    fleet: boolean,
    signal?: AbortSignal,
  ): Promise<RunningCodex> {
    const launchSignal = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    const { nodeId, workerKey } = assignment;
    const workerConfig = assignment.projectId === this.config.projectId
      ? this.config
      : { ...this.config, projectId: assignment.projectId };
    const suffix = randomUUID().slice(0, 8);
    const nodeSlug = slug(nodeId);
    const branch = `work/${nodeSlug}-${suffix}`;
    const root = join(dirname(this.config.targetRepoPath), ".missiongraph-worktrees");
    const worktree = join(root, `${basename(this.config.targetRepoPath)}-${nodeSlug}-${suffix}`);
    const reporterConfigPath = `${worktree}.reporter.conf`;
    const state: WorkerState = {
      status: "spawning",
      worktree,
      branch,
      reporter_config_path: reporterConfigPath,
      ...(fleet ? {
        node_id: nodeId,
        project_id: assignment.projectId,
        fleet_request_id: assignment.requestId,
      } : {}),
    };
    this.stateStore.state.workers[workerKey] = state;
    try {
      await this.stateStore.save();
      launchSignal.throwIfAborted();
      const credential = await new ReporterClient(workerConfig, this.dryRun).issue(`worker:${nodeId}`, launchSignal);
      launchSignal.throwIfAborted();
      await writeReporterConfig(reporterConfigPath, credential.token);
      launchSignal.throwIfAborted();
      await mkdir(root, { recursive: true });
      await runGit(["worktree", "add", worktree, "-b", branch], this.config.targetRepoPath, launchSignal);
      launchSignal.throwIfAborted();
      state.reporter_credential = credential.token;
      state.reporter_expires = credential.expires;
      await this.stateStore.save();

      let running: RunningCodex | undefined;
      let abortTermination: Promise<void> | undefined;
      const abortLaunch = () => {
        if (running) abortTermination ??= this.terminateFailedLaunch(workerKey, running);
      };
      try {
        const prompt = fleet
          ? adoptedWorkerBrief(nodeId, assignment.title, assignment.brief, worktree)
          : workerBrief(nodeId, assignment.brief, worktree);
        running = this.codex.startWorker(nodeId, prompt, worktree, reporterConfigPath, workerConfig);
        this.running.set(workerKey, running);
        this.leases.set(workerKey, lease);
        launchSignal.addEventListener("abort", abortLaunch, { once: true });
        const identity = await abortable(running.identity, launchSignal);
        state.pid = identity.pid;
        state.process_start_time = identity.starttime;
        await this.stateStore.save();
        launchSignal.throwIfAborted();
        running.begin();
        state.thread_id = await abortable(running.threadId, launchSignal);
        launchSignal.removeEventListener("abort", abortLaunch);
        state.status = "live";
        await this.stateStore.save();
      } catch (error) {
        launchSignal.removeEventListener("abort", abortLaunch);
        if (abortTermination) await abortTermination;
        else if (running) await this.terminateFailedLaunch(workerKey, running);
        state.status = "dead";
        delete state.pid;
        delete state.process_start_time;
        this.running.delete(workerKey);
        this.releaseLease(workerKey);
        await this.clearReporterCredential(state);
        await this.stateStore.save();
        throw error;
      }
      this.scheduleRenewal(workerKey, credential.expires);
      this.logger.info(`spawned worker ${nodeId} as thread ${state.thread_id} in ${worktree}`);
      this.trackInitialCompletion(workerKey, running, lease);
      return running;
    } catch (error) {
      if (this.stateStore.state.workers[workerKey] === state && state.status === "spawning") {
        state.status = "dead";
        delete state.pid;
        delete state.process_start_time;
        await this.clearReporterCredential(state);
        await this.stateStore.save();
      }
      await unlink(reporterConfigPath).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
      lease.release();
      throw error;
    }
  }

  private trackInitialCompletion(nodeId: string, running: RunningCodex, lease: ExecutionLease): void {
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
          delete current.pid;
          delete current.process_start_time;
          await this.clearReporterCredential(current);
          current.status = current.thread_id ? "idle" : "dead";
          await this.stateStore.save();
        }
      })
      .catch((error: unknown) => {
        this.logger.error(`failed to persist worker ${nodeId} process exit: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.leases.get(nodeId) === lease) this.leases.delete(nodeId);
        lease.release();
      });
    this.cleanupTasks.add(cleanup);
    void cleanup.finally(() => this.cleanupTasks.delete(cleanup));
  }

  private trackRecoveredCompletion(nodeId: string, identity: ProcessIdentity, lease: ExecutionLease): void {
    const cleanup = (async () => {
      while (!this.stopping) {
        try {
          if (!await this.recoveredProcessMatches(nodeId, identity)) {
            await this.settleRecoveredWorker(nodeId, identity);
            return;
          }
        } catch (error) {
          this.logger.error(
            `recovered worker ${nodeId} process lookup failed permanently: ${error instanceof Error ? error.message : String(error)}`,
          );
          await this.settleRecoveredWorker(nodeId, identity);
          return;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    })().catch((error: unknown) => {
      this.logger.error(
        `failed to monitor recovered worker ${nodeId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }).finally(() => {
      if (this.leases.get(nodeId) === lease) this.leases.delete(nodeId);
      lease.release();
    });
    this.cleanupTasks.add(cleanup);
    void cleanup.finally(() => this.cleanupTasks.delete(cleanup));
  }

  private async recoveredProcessMatches(nodeId: string, identity: ProcessIdentity): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await processMatches(identity, this.processStartTime);
      } catch (error) {
        const delay = recoveredLookupRetryDelaysMs[attempt];
        if (delay === undefined) throw error;
        this.logger.warn(
          `recovered worker ${nodeId} process lookup failed; retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`,
        );
        await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
      }
    }
  }

  private async settleRecoveredWorker(nodeId: string, identity: ProcessIdentity): Promise<void> {
    const current = this.stateStore.state.workers[nodeId];
    if (
      current?.pid !== identity.pid ||
      current.process_start_time !== identity.starttime
    ) return;
    delete current.pid;
    delete current.process_start_time;
    this.clearRenewal(nodeId);
    await this.clearReporterCredential(current);
    current.status = current.thread_id ? "idle" : "dead";
    await this.stateStore.save();
  }

  private async resumeWorker(
    nodeId: string,
    message: string,
    pendingId: string,
    action: "rebrief_worker" | "pause_worker" | "resume_worker",
  ): Promise<void> {
    const worker = this.stateStore.state.workers[nodeId];
    if (!worker || !worker.thread_id || worker.status === "spawning") {
      this.logger.warn(`worker action ignored because node ${nodeId} has no resumable tracked thread`);
      return;
    }
    if (worker.status === "live") {
      const note = `${action} for node ${nodeId} was rejected because its tracked worker process is still live.`;
      this.logger.warn(note);
      await this.journal(note, `${pendingId}:live-control-rejected`);
      return;
    }
    const lease = await this.slot.acquire(`flagship worker resume ${nodeId}`);
    if (this.stopping) {
      lease.release();
      throw new Error("bridge is shutting down");
    }
    let running: RunningCodex | undefined;
    try {
      await this.ensureCredential(nodeId, worker, this.shutdown.signal);
      if (this.stopping) throw new Error("bridge is shutting down");
      const reporterConfigPath = worker.reporter_config_path ?? `${worker.worktree}.reporter.conf`;
      running = this.codex.resumeWorker(
        nodeId,
        worker.thread_id,
        message,
        worker.worktree,
        reporterConfigPath,
      );
      this.running.set(nodeId, running);
      this.leases.set(nodeId, lease);
      const abortLaunch = () => void running?.terminate().catch(() => undefined);
      this.shutdown.signal.addEventListener("abort", abortLaunch, { once: true });
      const identity = await abortable(running.identity, this.shutdown.signal);
      worker.pid = identity.pid;
      worker.process_start_time = identity.starttime;
      worker.status = "spawning";
      await this.stateStore.save();
      running.begin();
      await abortable(running.threadId, this.shutdown.signal);
      this.shutdown.signal.removeEventListener("abort", abortLaunch);
      worker.status = "live";
      await this.stateStore.save();
      await running.completed;
    } catch (error) {
      if (running) await this.terminateFailedLaunch(nodeId, running);
      throw error;
    } finally {
      try {
        if (running && this.running.get(nodeId) === running) {
          this.running.delete(nodeId);
          delete worker.pid;
          delete worker.process_start_time;
          this.clearRenewal(nodeId);
          await this.clearReporterCredential(worker);
          worker.status = "idle";
          await this.stateStore.save();
        } else if (!running) {
          this.clearRenewal(nodeId);
          await this.clearReporterCredential(worker);
          await this.stateStore.save();
        }
      } finally {
        this.releaseLease(nodeId);
        lease.release();
      }
    }
  }

  private async terminateFailedLaunch(nodeId: string, running: RunningCodex): Promise<void> {
    try {
      await running.terminate();
    } catch (error) {
      this.logger.error(
        `failed to terminate worker ${nodeId} after launch failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async ensureCredential(nodeId: string, worker: WorkerState, signal: AbortSignal): Promise<void> {
    const reporterExpires = Date.parse(worker.reporter_expires ?? "");
    if (
      !worker.reporter_credential ||
      !Number.isFinite(reporterExpires) ||
      reporterExpires - Date.now() < reporterRenewalLeadMs
    ) {
      const credential = await this.reporterFor(worker).issue(`worker:${worker.node_id ?? nodeId}`, signal);
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
      const credential = await this.reporterFor(worker).issue(`worker:${worker.node_id ?? nodeId}`);
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
      if (worker) {
        await this.clearReporterCredential(worker);
        await this.stateStore.save();
      }
      this.releaseLease(nodeId);
      return;
    }
    const running = this.running.get(nodeId);
    if (running) {
      await running.terminate();
    } else {
      const identity = workerIdentity(worker);
      if (identity) await terminateProcess(identity, { lookup: this.processStartTime });
    }
    delete worker.pid;
    delete worker.process_start_time;
    this.running.delete(nodeId);
    this.clearRenewal(nodeId);
    try {
      await this.clearReporterCredential(worker);
      worker.status = worker.thread_id ? "idle" : "dead";
      await this.stateStore.save();
    } finally {
      this.releaseLease(nodeId);
    }
  }

  private reporterFor(worker: WorkerState): ReporterClient {
    if (!worker.project_id || worker.project_id === this.config.projectId) return this.reporter;
    return new ReporterClient({ ...this.config, projectId: worker.project_id }, this.dryRun);
  }

  private async clearReporterCredential(worker: WorkerState): Promise<void> {
    const reporterConfigPath = worker.reporter_config_path;
    if (reporterConfigPath) {
      await unlink(reporterConfigPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    delete worker.reporter_credential;
    delete worker.reporter_expires;
    delete worker.reporter_config_path;
  }

  private releaseLease(workerKey: string): void {
    const lease = this.leases.get(workerKey);
    this.leases.delete(workerKey);
    lease?.release();
  }
}
