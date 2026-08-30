import { ActionExecutor } from "./actions.js";
import { CodexClient } from "./codex.js";
import type { BridgeConfig } from "./config.js";
import {
  parseSupervisorDecision,
  strictDecisionReminder,
  validateSupervisorDecision,
} from "./decision.js";
import { EnvelopePump, type PreparedDelivery } from "./pump.js";
import { eventEnvelope, supervisorBrief } from "./prompts.js";
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
  ) {}

  async start(): Promise<void> {
    if (this.stateStore || this.stopping) throw new Error("bridge is already started or shutting down");
    const currentSnapshot = await snapshot(this.config);
    if (this.stopping) throw new Error("bridge is shutting down");
    const stateStore = await StateStore.open(this.config.statePath, this.config.projectId);
    this.stateStore = stateStore;
    try {
      if (this.stopping) throw new Error("bridge is shutting down");
      if (Number(stateStore.state.cursor) > Number(currentSnapshot.cursor)) {
        throw new Error("bridge cursor is ahead of the server snapshot");
      }
      const codex = new CodexClient(this.config, this.logger, this.dryRun);
      const actions = new ActionExecutor(this.config, stateStore, codex, this.logger, this.dryRun);
      this.codex = codex;
      this.actions = actions;
      if (this.stopping) throw new Error("bridge is shutting down");
      await actions.initialize();
      if (stateStore.recoveryMessage) {
        await stateStore.save();
        await actions.journal(stateStore.recoveryMessage);
        delete stateStore.state.recovery_note;
        await stateStore.save();
      }

      if (!stateStore.state.supervisor_thread_id) {
        const result = await codex.startSupervisor(supervisorBrief(currentSnapshot));
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
        async (count) => actions.journal(`Envelope queue dropped ${count} envelopes during a bounded flood; WORKER_LOG was preferred for eviction.`),
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
    const result = await this.codex.resumeSupervisor(threadId, payload);
    const range = `${events[0]?.seq ?? "?"}-${events.at(-1)?.seq ?? "?"}`;
    const decision = await this.parseWithRetry(result.stdout, threadId, `envelope seq ${range}`);
    if (!decision) {
      await this.actions.journal(`Supervisor decision was malformed for envelope seq ${range} after one strict-format retry; no actions were executed.`);
      return { afterCommit: async () => undefined };
    }
    const latest = await snapshot(this.config);
    const validated = validateSupervisorDecision(decision, latest);
    return {
      afterCommit: async () => {
        for (const note of validated.journal) {
          try {
            await this.actions?.journal(note);
          } catch (error) {
            this.logger.error(`failed to journal decision validation: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        await this.actions?.execute(validated.decision);
      },
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
    const retry = await this.codex?.resumeSupervisor(threadId, strictDecisionReminder);
    return retry ? parseSupervisorDecision(retry.stdout, this.logger) : undefined;
  }

  private async executeValidated(decision: SupervisorDecision, latest: Snapshot): Promise<void> {
    if (!this.actions) return;
    const validated = validateSupervisorDecision(decision, latest);
    for (const note of validated.journal) await this.actions.journal(note);
    await this.actions.execute(validated.decision);
  }
}
