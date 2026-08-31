import { ActionExecutor } from "./actions.js";
import { CodexClient, type CodexResult, type RunningCodex } from "./codex.js";
import type { BridgeConfig } from "./config.js";
import {
  parseSupervisorDecision,
  strictDecisionReminder,
  validateSupervisorDecision,
} from "./decision.js";
import { EnvelopePump, type PreparedDelivery } from "./pump.js";
import { eventEnvelope, supervisorBrief } from "./prompts.js";
import { readProcessStartTime, terminateProcess, type ProcessStartTimeLookup } from "./process.js";
import { StateStore, type BridgeState } from "./state.js";
import { streamEvents } from "./sse.js";
import type { Logger, MissionEvent, Snapshot, SupervisorDecision } from "./types.js";

async function snapshot(config: BridgeConfig): Promise<Snapshot> {
  const response = await fetch(
    `${config.serverUrl}/api/p/${encodeURIComponent(config.projectId)}/snapshot`,
    { headers: { "x-mg-token": config.visitorToken } },
  );
  if (!response.ok) throw new Error(`snapshot GET failed (${response.status}): ${await response.text()}`);
  const value = (await response.json()) as Snapshot;
  if (!/^\d+$/.test(value.cursor) || typeof value.state !== "object" || value.state === null) {
    throw new Error("snapshot response did not match the MissionGraph contract");
  }
  return value;
}

export class MissionGraphBridge {
  private stateStore: StateStore | undefined;
  private pump: EnvelopePump | undefined;
  private actions: ActionExecutor | undefined;
  private codex: CodexClient | undefined;
  private abort: AbortController | undefined;
  private stream: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    private readonly dryRun = false,
    private readonly processStartTime: ProcessStartTimeLookup = readProcessStartTime,
  ) {}

  async start(): Promise<void> {
    if (this.stateStore || this.stopping) throw new Error("bridge is already started or shutting down");
    const currentSnapshot = await snapshot(this.config);
    if (this.stopping) throw new Error("bridge is shutting down");
    const stateStore = await StateStore.open(this.config.statePath, this.config.projectId, this.processStartTime);
    this.stateStore = stateStore;
    try {
      if (this.stopping) throw new Error("bridge is shutting down");
      if (Number(stateStore.state.cursor) > Number(currentSnapshot.cursor)) {
        throw new Error("bridge cursor is ahead of the server snapshot");
      }
      if (this.dryRun) assertDryRunState(stateStore.path, stateStore.state);
      const supervisorRecovery = await this.reconcileSupervisorProcess(stateStore);
      const codex = new CodexClient(this.config, this.logger, this.dryRun, this.processStartTime);
      const actions = new ActionExecutor(this.config, stateStore, codex, this.logger, this.dryRun, this.processStartTime);
      this.codex = codex;
      this.actions = actions;
      if (this.stopping) throw new Error("bridge is shutting down");
      await actions.initialize();
      if (supervisorRecovery) {
        await actions.execute(
          { actions: [{ act: "note", text: supervisorRecovery }] },
          "startup supervisor process reconciliation",
        );
      }
      if (stateStore.recoveryMessage) {
        await stateStore.save();
        await actions.journal(stateStore.recoveryMessage);
        delete stateStore.state.recovery_note;
        await stateStore.save();
      }

      if (!stateStore.state.supervisor_thread_id) {
        const result = await this.runSupervisor(codex.startSupervisor(supervisorBrief(currentSnapshot)));
        if (!result.threadId) throw new Error("supervisor JSONL did not contain thread.started");
        stateStore.state.supervisor_thread_id = result.threadId;
        await stateStore.save();
        const decision = await this.parseWithRetry(result.stdout, result.threadId, "initialization");
        if (decision) await this.executeValidated(decision, currentSnapshot);
        else await actions.journal("Supervisor decision was malformed during initialization after one strict-format retry; no actions were executed.");
        this.logger.info(`supervisor thread ${result.threadId} persisted`);
      }

      this.pump = new EnvelopePump(
        (events) => this.prepareDelivery(events),
        async (cursor) => {
          stateStore.state.cursor = cursor;
          await stateStore.save();
        },
        this.logger,
        async (count) => actions.execute(
          { actions: [{ act: "note", text: `Envelope queue dropped ${count} WORKER_LOG envelopes during a bounded flood.` }] },
          `envelope queue flood through cursor ${stateStore.state.cursor}`,
        ),
      );
      this.abort = new AbortController();
      this.stream = streamEvents(
        this.config,
        stateStore.state.cursor,
        this.abort.signal,
        (event: MissionEvent) => this.pump?.enqueue(event),
        this.logger,
      );
    } catch (error) {
      this.actions?.beginShutdown();
      await Promise.all([this.codex?.stop(), this.actions?.terminateAll()]);
      await this.actions?.stop();
      await stateStore.close();
      this.stateStore = undefined;
      this.actions = undefined;
      this.codex = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort?.abort();
    this.pump?.stop();
    this.actions?.beginShutdown();
    await Promise.all([this.codex?.stop(), this.actions?.terminateAll()]);
    await this.actions?.stop();
    await this.stream;
    await this.pump?.whenIdle();
    await this.stateStore?.close();
    this.abort = undefined;
    this.stream = undefined;
    this.pump = undefined;
    this.actions = undefined;
    this.codex = undefined;
    this.stateStore = undefined;
  }

  async whenIdle(): Promise<void> {
    await this.pump?.whenIdle();
  }

  getState(): BridgeState | undefined {
    return this.stateStore ? structuredClone(this.stateStore.state) : undefined;
  }

  private async prepareDelivery(events: MissionEvent[]): Promise<PreparedDelivery> {
    const threadId = this.stateStore?.state.supervisor_thread_id;
    if (!threadId || !this.codex || !this.actions) throw new Error("supervisor thread is unavailable");
    const envelopes = events.map(eventEnvelope);
    const payload = JSON.stringify(envelopes.length === 1 ? envelopes[0] : envelopes);
    const result = await this.runSupervisor(this.codex.resumeSupervisor(threadId, payload));
    const range = `${events[0]?.seq ?? "?"}-${events.at(-1)?.seq ?? "?"}`;
    const decision = await this.parseWithRetry(result.stdout, threadId, `envelope seq ${range}`);
    if (!decision) {
      await this.actions.journal(
        `Supervisor decision was malformed for envelope seq ${range} after one strict-format retry; no actions were executed. A human may re-dispatch that sequence range.`,
        `bridge-malformed-${this.config.projectId}-${range}`,
      );
      return { afterCommit: async () => { await this.actions?.drainPending(); } };
    }
    const latest = await snapshot(this.config);
    const validated = validateSupervisorDecision(decision, latest);
    await this.actions.record(
      {
        actions: [
          ...validated.journal.map((text): SupervisorDecision["actions"][number] => ({ act: "note", text })),
          ...validated.decision.actions,
        ],
      },
      `envelope seq ${range}`,
    );
    return {
      afterCommit: async () => this.actions?.drainPending(),
    };
  }

  private async parseWithRetry(
    stdout: string,
    threadId: string,
    context: string,
  ): Promise<SupervisorDecision | undefined> {
    const first = parseSupervisorDecision(stdout, this.logger);
    if (first) return first;
    this.logger.warn(`retrying malformed supervisor decision for ${context}`);
    const running = this.codex?.resumeSupervisor(threadId, strictDecisionReminder);
    const retry = running ? await this.runSupervisor(running) : undefined;
    return retry ? parseSupervisorDecision(retry.stdout, this.logger) : undefined;
  }

  private async runSupervisor(running: RunningCodex): Promise<CodexResult> {
    const stateStore = this.stateStore;
    if (!stateStore) throw new Error("bridge state is unavailable");
    const identity = await running.identity;
    stateStore.state.supervisor_pid = identity.pid;
    stateStore.state.supervisor_process_start_time = identity.starttime;
    await stateStore.save();
    try {
      return await running.completed;
    } finally {
      if (
        stateStore.state.supervisor_pid === identity.pid &&
        stateStore.state.supervisor_process_start_time === identity.starttime
      ) {
        delete stateStore.state.supervisor_pid;
        delete stateStore.state.supervisor_process_start_time;
        await stateStore.save();
      }
    }
  }

  private async reconcileSupervisorProcess(stateStore: StateStore): Promise<string | undefined> {
    const pid = stateStore.state.supervisor_pid;
    const starttime = stateStore.state.supervisor_process_start_time;
    if (!pid && !starttime) return undefined;
    let terminated = false;
    if (pid && starttime) terminated = await terminateProcess({ pid, starttime }, { lookup: this.processStartTime });
    delete stateStore.state.supervisor_pid;
    delete stateStore.state.supervisor_process_start_time;
    await stateStore.save();
    return terminated
      ? `Startup reconciliation terminated the persisted supervisor child ${pid} after matching its process start time.`
      : `Startup reconciliation cleared a missing or mismatched persisted supervisor child${pid ? ` ${pid}` : ""} without signaling it.`;
  }

  private async executeValidated(decision: SupervisorDecision, latest: Snapshot): Promise<void> {
    if (!this.actions) return;
    const validated = validateSupervisorDecision(decision, latest);
    await this.actions.execute({
      actions: [
        ...validated.journal.map((text): SupervisorDecision["actions"][number] => ({ act: "note", text })),
        ...validated.decision.actions,
      ],
    }, "supervisor initialization");
  }
}

export function assertDryRunState(path: string, state: BridgeState): void {
  if (Object.keys(state.workers).length > 0 || state.supervisor_pid !== undefined) {
    throw new Error(`--dry-run refuses bridge state ${path} because it records workers or a supervisor process`);
  }
}
