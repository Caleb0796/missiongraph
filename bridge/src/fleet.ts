import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import type { RunningCodex } from "./codex.js";
import type { BridgeConfig } from "./config.js";
import type { ActionExecutor } from "./actions.js";
import { processMatches, readProcessStartTime, type ProcessStartTimeLookup } from "./process.js";
import { ReporterClient, reporterPayload } from "./reporter.js";
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
const lostWorkerReportTag = "fleet-lost-worker-state-v1";
const lostWorkerDetailPrefix =
  "Fleet worker was lost before it filed its reports (bridge restarted or worker exited early): ";
const lostWorkerNoteLimit = 200;
const terminalWorkerStates = new Set(["review", "failed", "paused"]);

function requestSignal(signal: AbortSignal, timeoutMs = fleetRequestTimeoutMs): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function lostWorkerDetail(note: string | undefined): string {
  const summary = (note ?? "No completion note was recorded.").replace(/\s+/g, " ").trim();
  return `${lostWorkerDetailPrefix}${summary.slice(0, lostWorkerNoteLimit)}`;
}

async function staleFleetResponse(response: Response): Promise<boolean> {
  if (response.status === 404) return true;
  if (response.status !== 409) return false;
  const body = await response.clone().json().catch(() => undefined) as { error?: { code?: unknown } } | undefined;
  return body?.error?.code === "fleet_request_state";
}

interface FleetProtocolEvent {
  seq: number;
  actor: string;
  type: string;
  payload: {
    node_id?: string;
    to?: string;
    detail?: string;
    handoff?: { v?: unknown; commits?: unknown };
  };
}

interface FleetCompletion {
  outcome: "done" | "failed";
  note?: string;
}

interface ScopedFleetAdoptionState extends FleetAdoptionState {
  ledger_seq_at_adoption?: number;
}

async function gitSucceeds(args: string[], cwd: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return await new Promise<boolean>((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, { cwd, signal, stdio: "ignore" });
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise(code === 0));
  });
}

async function commitExistsOnBranch(
  commit: string,
  worktree: string,
  branch: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) return false;
  if (!await gitSucceeds(["cat-file", "-e", `${commit}^{commit}`], worktree, signal)) return false;
  return await gitSucceeds(["merge-base", "--is-ancestor", commit, branch], worktree, signal);
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
      Number.isSafeInteger(candidate.seq) &&
      (candidate.seq as number) >= 0 &&
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

  async ledgerSequence(projectId: string, visitorToken: string, signal: AbortSignal): Promise<number> {
    const response = await fetch(
      `${this.config.serverUrl}/api/p/${encodeURIComponent(projectId)}/export`,
      {
        headers: { "x-mg-token": visitorToken },
        signal: requestSignal(signal),
      },
    );
    if (!response.ok) throw new Error(`fleet ledger export GET failed (${response.status}): ${await response.text()}`);
    return protocolEvents(await response.json()).reduce((latest, event) => Math.max(latest, event.seq), 0);
  }

  async protocolCompletion(
    projectId: string,
    nodeId: string,
    visitorToken: string,
    ledgerSeqAtAdoption: number | undefined,
    worktree: string,
    branch: string,
    signal: AbortSignal,
    exitDescription = "Fleet worker exited cleanly",
  ): Promise<FleetCompletion> {
    if (!Number.isSafeInteger(ledgerSeqAtAdoption) || ledgerSeqAtAdoption! < 0) {
      return {
        outcome: "failed",
        note: `${exitDescription} without required server ledger reports: adoption ledger sequence.`,
      };
    }
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
      (event) =>
        event.seq > ledgerSeqAtAdoption! &&
        event.actor === actor &&
        event.payload.node_id === nodeId,
    );
    const runningState = events.find(
      (event) => event.type === "NODE_STATE_CHANGED" && event.payload.to === "running",
    );
    const terminalState = events.find(
      (event) =>
        runningState !== undefined &&
        event.seq > runningState.seq &&
        event.type === "NODE_STATE_CHANGED" &&
        event.payload.to !== undefined &&
        ["review", "failed"].includes(event.payload.to),
    );
    if (terminalState?.payload.to === "failed") {
      const detail = terminalState.payload.detail;
      return {
        outcome: "failed",
        note: `Fleet worker reported terminal NODE_STATE_CHANGED to failed${detail ? `: ${detail}` : "."}`,
      };
    }
    const handoff = events.find(
      (event) =>
        terminalState !== undefined &&
        event.seq > terminalState.seq &&
        event.type === "HANDOFF_FILED" &&
        event.payload.handoff?.v === 1,
    );
    const approvals = events.filter((event) => event.type === "APPROVAL_CREATED");
    const commits = handoff?.payload.handoff?.commits;
    const commitList = Array.isArray(commits) && commits.length > 0 && commits.every((commit) => typeof commit === "string")
      ? commits as string[]
      : undefined;
    const invalidCommits: string[] = [];
    for (const commit of commitList ?? []) {
      if (!await commitExistsOnBranch(commit, worktree, branch, signal)) invalidCommits.push(commit);
    }
    const missing = [
      ...(runningState && terminalState ? [] : ["ordered NODE_STATE_CHANGED running→review|failed"]),
      ...(handoff ? [] : ["v1 HANDOFF_FILED"]),
      ...(commitList ? [] : ["non-empty HANDOFF_FILED commits"]),
      ...(invalidCommits.length === 0 ? [] : [`valid HANDOFF_FILED commits (${invalidCommits.join(", ")})`]),
      ...(approvals.length === 1 && handoff && approvals[0]!.seq > handoff.seq
        ? []
        : ["exactly one ordered APPROVAL_CREATED"]),
    ];
    if (missing.length > 0) {
      return {
        outcome: "failed",
        note: `${exitDescription} without required server ledger reports: ${missing.join(", ")}.`,
      };
    }
    return { outcome: "done" };
  }

  async shouldReportLostWorker(
    projectId: string,
    nodeId: string,
    visitorToken: string,
    ledgerSeqAtAdoption: number | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(ledgerSeqAtAdoption) || ledgerSeqAtAdoption! < 0) return false;
    const exportResponse = await fetch(
      `${this.config.serverUrl}/api/p/${encodeURIComponent(projectId)}/export`,
      {
        headers: { "x-mg-token": visitorToken },
        signal: requestSignal(signal),
      },
    );
    if (!exportResponse.ok) {
      throw new Error(`fleet ledger export GET failed (${exportResponse.status}): ${await exportResponse.text()}`);
    }
    const actor = `worker:${nodeId}`;
    const terminalReported = protocolEvents(await exportResponse.json()).some(
      (event) =>
        event.seq > ledgerSeqAtAdoption! &&
        event.actor === actor &&
        event.type === "NODE_STATE_CHANGED" &&
        event.payload.node_id === nodeId &&
        event.payload.to !== undefined &&
        terminalWorkerStates.has(event.payload.to),
    );
    if (terminalReported) return false;
    const snapshotResponse = await fetch(
      `${this.config.serverUrl}/api/p/${encodeURIComponent(projectId)}/snapshot`,
      {
        headers: { "x-mg-token": visitorToken },
        signal: requestSignal(signal),
      },
    );
    if (!snapshotResponse.ok) {
      throw new Error(`fleet snapshot GET failed (${snapshotResponse.status}): ${await snapshotResponse.text()}`);
    }
    const body = await snapshotResponse.json() as { state?: { nodes?: Record<string, { state?: unknown }> } };
    return body.state?.nodes?.[nodeId]?.state === "running";
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
      let ledgerSeqAtAdoption: number;
      try {
        ledgerSeqAtAdoption = await this.client.ledgerSequence(
          claim.project_id,
          claim.visitor_token,
          this.abort.signal,
        );
      } catch (error) {
        await this.client.complete(
          claim.request_id,
          "failed",
          this.abort.signal,
          `Fleet adoption ledger boundary failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      const adoption: ScopedFleetAdoptionState = {
        request_id: claim.request_id,
        project_id: claim.project_id,
        node_id: claim.node_id,
        node: claim.node,
        visitor_token: claim.visitor_token,
        worker_key: `fleet:${claim.request_id}`,
        status: "adopted",
        adopted_at: new Date().toISOString(),
        ledger_seq_at_adoption: ledgerSeqAtAdoption,
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
      const completion = await this.verifyProtocolCompletion(adoption, claimAbort.signal);
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
      await this.beginCompletion(
        adoption,
        "failed",
        "Fleet worker was lost after a bridge restart because no tracked process survived.",
      );
      return;
    }
    if (worker.status !== "live" || !worker.pid || !worker.process_start_time) {
      const completion = await this.verifyProtocolCompletion(
        adoption,
        this.abort.signal,
        "Fleet worker was lost after a bridge restart or its tracked process disappeared",
      );
      await this.beginCompletion(adoption, completion.outcome, completion.note);
      return;
    }
    const deadline = Date.parse(adoption.started_at ?? adoption.adopted_at) + this.config.fleetRunTtlMs;
    if (Date.now() >= deadline) {
      await this.actions.killTrackedWorker(adoption.worker_key);
      await this.beginCompletion(adoption, "failed", "Recovered fleet worker exceeded FLEET_RUN_TTL_MIN and was terminated.");
      return;
    }
    if (!await processMatches({ pid: worker.pid, starttime: worker.process_start_time }, this.processStartTime)) {
      const completion = await this.verifyProtocolCompletion(
        adoption,
        this.abort.signal,
        "Fleet worker was lost after a bridge restart or its tracked process disappeared",
      );
      await this.beginCompletion(adoption, completion.outcome, completion.note);
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

  private async verifyProtocolCompletion(
    adoption: FleetAdoptionState,
    signal: AbortSignal,
    exitDescription?: string,
  ): Promise<FleetCompletion> {
    const worker = this.stateStore.state.workers[adoption.worker_key];
    if (!worker) {
      return {
        outcome: "failed",
        note: "Fleet worker exited cleanly without required server ledger reports: persisted worker checkout.",
      };
    }
    try {
      return await this.client.protocolCompletion(
        adoption.project_id,
        adoption.node_id,
        adoption.visitor_token,
        (adoption as ScopedFleetAdoptionState).ledger_seq_at_adoption,
        worker.worktree,
        worker.branch,
        signal,
        exitDescription,
      );
    } catch (error) {
      return {
        outcome: "failed",
        note: `Fleet worker protocol verification failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
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
    if (adoption.outcome === "failed") {
      await this.reportLostWorker(adoption).catch((error: unknown) => {
        this.logger.warn(
          `failed to report lost fleet worker ${adoption.node_id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    if (!await this.client.complete(adoption.request_id, adoption.outcome, this.abort.signal, adoption.note)) {
      await this.abandon(adoption, adoption.note ?? "Fleet claim disappeared before completion.");
      return;
    }
    await this.detach(adoption);
  }

  private async reportLostWorker(adoption: FleetAdoptionState): Promise<void> {
    if (!await this.client.shouldReportLostWorker(
      adoption.project_id,
      adoption.node_id,
      adoption.visitor_token,
      (adoption as ScopedFleetAdoptionState).ledger_seq_at_adoption,
      this.abort.signal,
    )) return;
    const actor = `worker:${adoption.node_id}` as const;
    const projectConfig = {
      ...this.config,
      projectId: adoption.project_id,
      visitorToken: adoption.visitor_token,
    };
    const credential = this.stateStore.state.workers[adoption.worker_key]?.reporter_credential ??
      (await new ReporterClient(projectConfig).issue(actor, this.abort.signal)).token;
    const idemKey = createHash("sha256")
      .update(adoption.project_id)
      .update("\0")
      .update(adoption.node_id)
      .update("\0")
      .update(adoption.request_id)
      .update("\0")
      .update(lostWorkerReportTag)
      .digest("hex");
    const reporter = new ReporterClient({ ...projectConfig, reporterCredential: credential });
    await reporter.post(reporterPayload(actor, "NODE_STATE_CHANGED", {
      node_id: adoption.node_id,
      from: "running",
      to: "failed",
      detail: lostWorkerDetail(adoption.note),
    }, idemKey));
  }

  private async abandon(adoption: FleetAdoptionState, note: string): Promise<void> {
    this.logger.warn(`fleet adoption ${adoption.request_id} detached without completion: ${note}`);
    await this.detach(adoption);
  }

  private async detach(adoption: FleetAdoptionState): Promise<void> {
    await this.actions.clearTrackedReporter(adoption.worker_key);
    await this.actions.removeTrackedWorktree(adoption.worker_key);
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
