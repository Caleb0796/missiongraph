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
  node: { title: string; brief: string; estimate: number };
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

const fleetRequestTimeoutMs = 30_000;

function requestSignal(signal: AbortSignal, timeoutMs = fleetRequestTimeoutMs): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

async function staleFleetResponse(response: Response): Promise<boolean> {
  if (response.status === 404) return true;
  if (response.status !== 409) return false;
  const body = await response.clone().json().catch(() => undefined) as { error?: { code?: unknown } } | undefined;
  return body?.error?.code === "fleet_request_state";
}

interface FleetProtocolEvent {
  actor: string;
  type: string;
  payload: { node_id?: string; to?: string; detail?: string };
}

interface FleetCompletion {
  outcome: "done" | "failed";
  note?: string;
}

function protocolEvents(value: unknown): FleetProtocolEvent[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fleet ledger export did not match the MissionGraph contract");
  }
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events)) throw new Error("fleet ledger export did not match the MissionGraph contract");
  return events.filter((event): event is FleetProtocolEvent => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) return false;
    const candidate = event as Partial<FleetProtocolEvent>;
    return (
      typeof candidate.actor === "string" &&
      typeof candidate.type === "string" &&
      typeof candidate.payload === "object" &&
      candidate.payload !== null &&
      !Array.isArray(candidate.payload)
    );
  });
}

class FleetClient {
  constructor(private readonly config: BridgeConfig) {}

  async next(signal: AbortSignal): Promise<FleetClaim | undefined> {
    const response = await fetch(`${this.config.serverUrl}/api/fleet/next`, {
      method: "POST",
      headers: { "x-mg-reporter": this.config.reporterCredential },
      signal: requestSignal(signal),
    });
    if (response.status === 204) return undefined;
    if (!response.ok) throw new Error(`fleet next POST failed (${response.status}): ${await response.text()}`);
    return claimValue(await response.json());
  }

  async heartbeat(requestId: string, signal: AbortSignal): Promise<boolean> {
    const response = await fetch(
      `${this.config.serverUrl}/api/fleet/${encodeURIComponent(requestId)}/heartbeat`,
      {
        method: "POST",
        headers: { "x-mg-reporter": this.config.reporterCredential },
        // Cap the network timeout at the heartbeat cadence so requests never pile up past
        // one interval (heartbeatInFlight already drops overlapping ticks), but keep a real
        // floor: a test-speed cadence of a few ms must not shrink an HTTP timeout below
        // what a healthy localhost round-trip needs on a slow CI runner.
        signal: requestSignal(
          signal,
          Math.max(1_000, Math.min(this.config.fleetHeartbeatMs, fleetRequestTimeoutMs)),
        ),
      },
    );
    if (await staleFleetResponse(response)) return false;
    if (!response.ok) throw new Error(`fleet heartbeat POST failed (${response.status}): ${await response.text()}`);
    return true;
  }

  async complete(
    requestId: string,
    outcome: "done" | "failed",
    signal: AbortSignal,
    note?: string,
  ): Promise<boolean> {
    const response = await fetch(
      `${this.config.serverUrl}/api/fleet/${encodeURIComponent(requestId)}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mg-reporter": this.config.reporterCredential,
        },
        body: JSON.stringify({ outcome, ...(note ? { note } : {}) }),
        signal: requestSignal(signal),
      },
    );
    if (await staleFleetResponse(response)) return false;
    if (!response.ok) throw new Error(`fleet complete POST failed (${response.status}): ${await response.text()}`);
    return true;
  }

  async protocolCompletion(
    projectId: string,
    nodeId: string,
    visitorToken: string,
    signal: AbortSignal,
  ): Promise<FleetCompletion> {
    const response = await fetch(
      `${this.config.serverUrl}/api/p/${encodeURIComponent(projectId)}/export`,
      {
        headers: { "x-mg-token": visitorToken },
        signal: requestSignal(signal),
      },
    );
    if (!response.ok) throw new Error(`fleet ledger export GET failed (${response.status}): ${await response.text()}`);
    const actor = `worker:${nodeId}`;
    const events = protocolEvents(await response.json()).filter(
      (event) => event.actor === actor && event.payload.node_id === nodeId,
    );
    const terminalState = events.findLast(
      (event) =>
        event.type === "NODE_STATE_CHANGED" &&
        event.payload.to !== undefined &&
        ["review", "done", "failed"].includes(event.payload.to),
    );
    if (terminalState?.payload.to === "failed") {
      const detail = terminalState.payload.detail;
      return {
        outcome: "failed",
        note: `Fleet worker reported terminal NODE_STATE_CHANGED to failed${detail ? `: ${detail}` : "."}`,
      };
    }
    const missing = [
      ...(terminalState ? [] : ["terminal NODE_STATE_CHANGED"]),
      ...(events.some((event) => event.type === "HANDOFF_FILED") ? [] : ["HANDOFF_FILED"]),
      ...(events.some((event) => event.type === "APPROVAL_CREATED") ? [] : ["APPROVAL_CREATED"]),
    ];
    if (missing.length > 0) {
      return {
        outcome: "failed",
        note: `Fleet worker exited cleanly without required server ledger reports: ${missing.join(", ")}.`,
      };
    }
    return { outcome: "done" };
  }
}

type ClaimEnd = "shutdown" | "stale" | "ttl";

function waitForClaimEnd(signal: AbortSignal): Promise<ClaimEnd> {
  if (signal.aborted) return Promise.resolve(signal.reason as ClaimEnd);
  return new Promise<ClaimEnd>((resolve) => {
    signal.addEventListener("abort", () => resolve(signal.reason as ClaimEnd), { once: true });
  });
}

const terminalStatuses = new Set<FleetAdoptionState["status"]>(["completed", "abandoned"]);

export class FleetAdoptionLoop {
  private readonly client: FleetClient;
  private readonly abort = new AbortController();
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
    this.abort.abort("shutdown");
    this.wake?.();
    await this.activeWorker?.terminate().catch((error: unknown) => {
      this.logger.error(`fleet worker termination failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await this.task;
    const adoption = this.stateStore.state.fleet_adoption;
    if (adoption && !terminalStatuses.has(adoption.status) && adoption.status !== "completing") {
      await this.actions.killTrackedWorker(adoption.worker_key);
      adoption.status = "completing";
      adoption.outcome = "failed";
      adoption.note = "Bridge shutdown terminated the adopted worker.";
      await this.stateStore.save();
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const adoption = this.stateStore.state.fleet_adoption;
        if (adoption && !terminalStatuses.has(adoption.status)) await this.recover(adoption);
        else await this.poll();
      } catch (error) {
        if (!this.stopping) {
          this.logger.error(`fleet adoption cycle failed: ${error instanceof Error ? error.message : String(error)}`);
        }
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
      claim = await this.client.next(this.abort.signal);
      if (previous && terminalStatuses.has(previous.status)) {
        if (claim?.request_id === previous.request_id) {
          await this.client.complete(
            claim.request_id,
            previous.outcome ?? "failed",
            this.abort.signal,
            previous.note,
          );
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
    const claimAbort = new AbortController();
    const abortForShutdown = () => claimAbort.abort("shutdown");
    this.abort.signal.addEventListener("abort", abortForShutdown, { once: true });
    if (this.abort.signal.aborted) abortForShutdown();
    const deadline = Date.parse(adoption.adopted_at) + this.config.fleetRunTtlMs;
    const watchdogTimer = setTimeout(() => claimAbort.abort("ttl"), Math.max(0, deadline - Date.now()));
    watchdogTimer.unref();
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let launchAttempted = false;
    try {
      let accepted: boolean;
      try {
        accepted = await this.client.heartbeat(adoption.request_id, claimAbort.signal);
      } catch (error) {
        if (claimAbort.signal.aborted) {
          lease.release();
          await this.finishEndedClaim(adoption, claimAbort.signal.reason as ClaimEnd);
          return;
        }
        lease.release();
        await this.beginCompletion(
          adoption,
          "failed",
          `Fleet claim revalidation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      if (!accepted) {
        lease.release();
        await this.abandon(adoption, "Fleet claim became stale before worker launch.");
        return;
      }
      adoption.heartbeat_at = new Date().toISOString();
      await this.stateStore.save();

      let heartbeatInFlight = false;
      const heartbeat = async (): Promise<void> => {
        if (heartbeatInFlight || claimAbort.signal.aborted) return;
        heartbeatInFlight = true;
        try {
          if (!await this.client.heartbeat(adoption.request_id, claimAbort.signal)) {
            claimAbort.abort("stale");
            return;
          }
          adoption.heartbeat_at = new Date().toISOString();
          await this.stateStore.save();
        } catch (error) {
          if (!claimAbort.signal.aborted) {
            this.logger.error(`fleet heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        } finally {
          heartbeatInFlight = false;
        }
      };
      heartbeatTimer = setInterval(() => void heartbeat(), this.config.fleetHeartbeatMs);
      heartbeatTimer.unref();

      let running: RunningCodex;
      try {
        launchAttempted = true;
        running = await this.actions.spawnFleetWorker({
          requestId: adoption.request_id,
          projectId: adoption.project_id,
          nodeId: adoption.node_id,
          title: adoption.node.title,
          brief: adoption.node.brief,
          workerKey: adoption.worker_key,
        }, lease, claimAbort.signal);
      } catch (error) {
        if (claimAbort.signal.aborted) {
          await this.finishEndedClaim(adoption, claimAbort.signal.reason as ClaimEnd);
          return;
        }
        await this.beginCompletion(
          adoption,
          "failed",
          `Fleet worker launch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      this.activeWorker = running;
      adoption.status = "running";
      adoption.started_at = new Date().toISOString();
      await this.stateStore.save();
      const result = await Promise.race([
        running.completed.then(
          () => ({ type: "completed" as const, outcome: "done" as const }),
          (error: unknown) => ({
            type: "completed" as const,
            outcome: "failed" as const,
            note: `Fleet worker exited unsuccessfully: ${error instanceof Error ? error.message : String(error)}`,
          }),
        ),
        waitForClaimEnd(claimAbort.signal).then((reason) => ({ type: "ended" as const, reason })),
      ]);
      if (result.type === "ended") {
        await running.terminate().catch(() => undefined);
        await this.finishEndedClaim(adoption, result.reason);
        return;
      }
      if (result.outcome === "failed") {
        await this.beginCompletion(adoption, result.outcome, result.note);
        return;
      }
      let completion: FleetCompletion;
      try {
        completion = await this.client.protocolCompletion(
          adoption.project_id,
          adoption.node_id,
          adoption.visitor_token,
          claimAbort.signal,
        );
      } catch (error) {
        completion = {
          outcome: "failed",
          note: `Fleet worker protocol verification failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      await this.beginCompletion(adoption, completion.outcome, completion.note);
    } finally {
      if (!launchAttempted) lease.release();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      clearTimeout(watchdogTimer);
      this.abort.signal.removeEventListener("abort", abortForShutdown);
      this.activeWorker = undefined;
    }
  }

  private async finishEndedClaim(adoption: FleetAdoptionState, reason: ClaimEnd): Promise<void> {
    if (reason === "shutdown") return;
    await this.actions.killTrackedWorker(adoption.worker_key);
    if (reason === "stale") {
      await this.abandon(adoption, "Fleet claim became stale while the worker was running.");
      return;
    }
    await this.beginCompletion(
      adoption,
      "failed",
      "Fleet worker exceeded FLEET_RUN_TTL_MIN and was terminated.",
    );
  }

  private async recover(adoption: FleetAdoptionState): Promise<void> {
    if (adoption.status === "completing") {
      await this.finishCompletion(adoption);
      return;
    }
    const worker = this.stateStore.state.workers[adoption.worker_key];
    if (!worker) {
      await this.beginCompletion(adoption, "failed", "Bridge restart found no live process for the adopted claim.");
      return;
    }
    if (worker.status !== "live" || !worker.pid || !worker.process_start_time) {
      await this.beginCompletion(adoption, "failed", "Recovered fleet worker process was no longer running.");
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
    if (!await this.client.heartbeat(adoption.request_id, this.abort.signal)) {
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
    if (!await this.client.complete(adoption.request_id, adoption.outcome, this.abort.signal, adoption.note)) {
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
    await this.actions.clearTrackedReporter(adoption.worker_key);
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
