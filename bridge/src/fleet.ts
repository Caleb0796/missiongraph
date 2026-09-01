import type { RunningCodex } from "./codex.js";
import type { BridgeConfig } from "./config.js";
import type { ActionExecutor } from "./actions.js";
import { processMatches, readProcessStartTime, type ProcessStartTimeLookup } from "./process.js";
import type { FleetAdoptionState, StateStore } from "./state.js";
import { ExecutionSlot, type ExecutionLease } from "./slot.js";
import type { Logger } from "./types.js";

export interface FleetClaim {
  request_id: string;
  project_id: string;
  node_id: string;
  node: {
    title: string;
    brief: string;
    estimate: number;
  };
  visitor_token: string;
}

function claimValue(value: unknown): FleetClaim {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fleet next response did not match the MissionGraph contract");
  }
  const claim = value as Partial<FleetClaim>;
  const node = claim.node as Partial<FleetClaim["node"]> | undefined;
  if (
    typeof claim.request_id !== "string" ||
    typeof claim.project_id !== "string" ||
    typeof claim.node_id !== "string" ||
    typeof claim.visitor_token !== "string" ||
    typeof node !== "object" ||
    node === null ||
    typeof node.title !== "string" ||
    typeof node.brief !== "string" ||
    typeof node.estimate !== "number" ||
    !Number.isFinite(node.estimate)
  ) {
    throw new Error("fleet next response did not match the MissionGraph contract");
  }
  return claim as FleetClaim;
}

class FleetClient {
  constructor(private readonly config: BridgeConfig) {}

  async next(): Promise<FleetClaim | undefined> {
    const response = await fetch(`${this.config.serverUrl}/api/fleet/next`, {
      method: "POST",
      headers: { "x-mg-reporter": this.config.reporterCredential },
    });
    if (response.status === 204) return undefined;
    if (!response.ok) throw new Error(`fleet next POST failed (${response.status}): ${await response.text()}`);
    return claimValue(await response.json());
  }

  async heartbeat(requestId: string): Promise<boolean> {
    const response = await fetch(
      `${this.config.serverUrl}/api/fleet/${encodeURIComponent(requestId)}/heartbeat`,
      {
        method: "POST",
        headers: { "x-mg-reporter": this.config.reporterCredential },
        signal: AbortSignal.timeout(Math.min(this.config.fleetHeartbeatMs, 30_000)),
      },
    );
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`fleet heartbeat POST failed (${response.status}): ${await response.text()}`);
    return true;
  }

  async complete(requestId: string, outcome: "done" | "failed", note?: string): Promise<boolean> {
    const response = await fetch(
      `${this.config.serverUrl}/api/fleet/${encodeURIComponent(requestId)}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mg-reporter": this.config.reporterCredential,
        },
        body: JSON.stringify({ outcome, ...(note ? { note } : {}) }),
      },
    );
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`fleet complete POST failed (${response.status}): ${await response.text()}`);
    return true;
  }
}

const terminalStatuses = new Set<FleetAdoptionState["status"]>(["completed", "abandoned"]);

export class FleetAdoptionLoop {
  private readonly client: FleetClient;
  private task: Promise<void> | undefined;
  private activeWorker: RunningCodex | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly config: BridgeConfig,
    private readonly stateStore: StateStore,
    private readonly actions: ActionExecutor,
    private readonly slot: ExecutionSlot,
    private readonly logger: Logger,
    private readonly processStartTime: ProcessStartTimeLookup = readProcessStartTime,
  ) {
    this.client = new FleetClient(config);
  }

  start(): void {
    if (this.task) throw new Error("fleet adoption loop is already started");
    if (!this.config.fleetMode) {
      this.task = Promise.resolve();
      return;
    }
    this.task = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.activeWorker?.terminate().catch((error: unknown) => {
      this.logger.error(`fleet worker termination failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await this.task;
    const adoption = this.stateStore.state.fleet_adoption;
    try {
      if (adoption && !terminalStatuses.has(adoption.status) && adoption.status !== "completing") {
        await this.actions.killTrackedWorker(adoption.worker_key);
        await this.beginCompletion(adoption, "failed", "Bridge shutdown terminated the adopted worker.");
      } else if (adoption?.status === "completing") {
        await this.finishCompletion(adoption);
      }
    } catch (error) {
      this.logger.error(`fleet completion remains pending after shutdown: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const adoption = this.stateStore.state.fleet_adoption;
        if (adoption && !terminalStatuses.has(adoption.status)) await this.recover(adoption);
        else await this.poll();
      } catch (error) {
        this.logger.error(`fleet adoption cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!this.stopping) await this.delay(this.config.fleetPollMs);
    }
  }

  private async poll(): Promise<void> {
    const lease = this.slot.tryAcquire("fleet adoption");
    if (!lease) return;
    let transferred = false;
    let claim: FleetClaim | undefined;
    try {
      const previous = this.stateStore.state.fleet_adoption;
      claim = await this.client.next();
      if (previous && terminalStatuses.has(previous.status)) {
        if (claim?.request_id === previous.request_id) {
          await this.client.complete(claim.request_id, previous.outcome ?? "failed", previous.note);
        }
        await this.detach(previous);
        if (!claim || claim.request_id === previous.request_id) return;
      }
      if (!claim) return;
      const adoption: FleetAdoptionState = {
        request_id: claim.request_id,
        project_id: claim.project_id,
        node_id: claim.node_id,
        node: claim.node,
        visitor_token: claim.visitor_token,
        worker_key: `fleet:${claim.request_id}`,
        status: "adopted",
        adopted_at: new Date().toISOString(),
      };
      this.stateStore.state.fleet_adoption = adoption;
      await this.stateStore.save();
      transferred = true;
      await this.runClaim(adoption, lease);
    } finally {
      if (!transferred) lease.release();
    }
  }

  private async runClaim(adoption: FleetAdoptionState, lease: ExecutionLease): Promise<void> {
    let running: RunningCodex;
    try {
      running = await this.actions.spawnFleetWorker({
        requestId: adoption.request_id,
        projectId: adoption.project_id,
        nodeId: adoption.node_id,
        title: adoption.node.title,
        brief: adoption.node.brief,
        workerKey: adoption.worker_key,
      }, lease);
    } catch (error) {
      await this.beginCompletion(
        adoption,
        "failed",
        `Fleet worker launch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    this.activeWorker = running;
    let outcome: { outcome: "done" | "failed"; note?: string };
    try {
      adoption.status = "running";
      adoption.started_at = new Date().toISOString();
      await this.stateStore.save();
      outcome = await this.monitorRunning(adoption, running);
    } catch (error) {
      await running.terminate().catch(() => undefined);
      outcome = {
        outcome: "failed",
        note: `Fleet worker monitoring failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      this.activeWorker = undefined;
    }
    await this.beginCompletion(adoption, outcome.outcome, outcome.note);
  }

  private async monitorRunning(
    adoption: FleetAdoptionState,
    running: RunningCodex,
  ): Promise<{ outcome: "done" | "failed"; note?: string }> {
    let heartbeatInFlight = false;
    let settleHeartbeat!: (result: { outcome: "failed"; note: string }) => void;
    const heartbeatFailure = new Promise<{ outcome: "failed"; note: string }>((resolve) => {
      settleHeartbeat = resolve;
    });
    let heartbeatStale = false;
    const heartbeatStaleFailure = {
      outcome: "failed" as const,
      note: "Fleet claim became stale while the worker was running.",
    };
    const heartbeat = async (): Promise<void> => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      try {
        if (!await this.client.heartbeat(adoption.request_id)) {
          heartbeatStale = true;
          await running.terminate();
          settleHeartbeat(heartbeatStaleFailure);
          return;
        }
        adoption.heartbeat_at = new Date().toISOString();
        await this.stateStore.save();
      } catch (error) {
        this.logger.error(`fleet heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        heartbeatInFlight = false;
      }
    };
    const heartbeatTimer = setInterval(() => void heartbeat(), this.config.fleetHeartbeatMs);
    heartbeatTimer.unref();
    let watchdogTriggered = false;
    const watchdogFailure = {
      outcome: "failed" as const,
      note: "Fleet worker exceeded FLEET_RUN_TTL_MIN and was terminated.",
    };
    let watchdogTimer!: NodeJS.Timeout;
    const watchdog = new Promise<{ outcome: "failed"; note: string }>((resolve) => {
      const timer = setTimeout(() => {
        watchdogTriggered = true;
        void running.terminate().finally(() => resolve(watchdogFailure));
      }, this.config.fleetRunTtlMs);
      timer.unref();
      watchdogTimer = timer;
    });
    try {
      await heartbeat();
      return await Promise.race([
        running.completed.then(
          () => watchdogTriggered
            ? watchdogFailure
            : heartbeatStale ? heartbeatStaleFailure : { outcome: "done" as const },
          (error: unknown) => watchdogTriggered
            ? watchdogFailure
            : heartbeatStale ? heartbeatStaleFailure : {
            outcome: "failed" as const,
            note: `Fleet worker exited unsuccessfully: ${error instanceof Error ? error.message : String(error)}`,
          },
        ),
        heartbeatFailure,
        watchdog,
      ]);
    } finally {
      clearInterval(heartbeatTimer);
      clearTimeout(watchdogTimer);
    }
  }

  private async recover(adoption: FleetAdoptionState): Promise<void> {
    if (adoption.status === "completing") {
      await this.finishCompletion(adoption);
      return;
    }
    const worker = this.stateStore.state.workers[adoption.worker_key];
    if (!worker || worker.status !== "live" || !worker.pid || !worker.process_start_time) {
      await this.beginCompletion(adoption, "failed", "Bridge restart found no live process for the adopted claim.");
      return;
    }
    const deadline = Date.parse(adoption.started_at ?? adoption.adopted_at) + this.config.fleetRunTtlMs;
    if (Date.now() >= deadline) {
      await this.actions.killTrackedWorker(adoption.worker_key);
      await this.beginCompletion(adoption, "failed", "Recovered fleet worker exceeded FLEET_RUN_TTL_MIN and was terminated.");
      return;
    }
    if (!await processMatches({ pid: worker.pid, starttime: worker.process_start_time }, this.processStartTime)) {
      await this.actions.killTrackedWorker(adoption.worker_key);
      await this.beginCompletion(adoption, "failed", "Recovered fleet worker process was no longer running.");
      return;
    }
    if (!await this.client.heartbeat(adoption.request_id)) {
      await this.actions.killTrackedWorker(adoption.worker_key);
      await this.abandon(adoption, "Recovered fleet claim was stale.");
      return;
    }
    adoption.status = "running";
    adoption.heartbeat_at = new Date().toISOString();
    await this.stateStore.save();
  }

  private async beginCompletion(
    adoption: FleetAdoptionState,
    outcome: "done" | "failed",
    note?: string,
  ): Promise<void> {
    adoption.status = "completing";
    adoption.outcome = outcome;
    if (note) adoption.note = note;
    await this.stateStore.save();
    await this.finishCompletion(adoption);
  }

  private async finishCompletion(adoption: FleetAdoptionState): Promise<void> {
    if (!adoption.outcome) throw new Error("persisted fleet completion is missing its outcome");
    if (!await this.client.complete(adoption.request_id, adoption.outcome, adoption.note)) {
      await this.abandon(adoption, adoption.note ?? "Fleet claim disappeared before completion.");
      return;
    }
    await this.detach(adoption);
  }

  private async abandon(adoption: FleetAdoptionState, note: string): Promise<void> {
    this.logger.warn(`fleet adoption ${adoption.request_id} detached without completion: ${note}`);
    await this.detach(adoption);
  }

  private async detach(adoption: FleetAdoptionState): Promise<void> {
    delete this.stateStore.state.workers[adoption.worker_key];
    if (this.stateStore.state.fleet_adoption?.request_id === adoption.request_id) {
      delete this.stateStore.state.fleet_adoption;
    }
    await this.stateStore.save();
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, ms);
      timer.unref();
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}
