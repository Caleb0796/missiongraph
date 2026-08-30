import { ActionExecutor } from "./actions.js";
import { CodexClient } from "./codex.js";
import type { BridgeConfig } from "./config.js";
import { parseSupervisorDecision } from "./decision.js";
import { EnvelopePump } from "./pump.js";
import { eventEnvelope, supervisorBrief } from "./prompts.js";
import { StateStore, type BridgeState } from "./state.js";
import { streamEvents } from "./sse.js";
import type { Logger, MissionEvent, Snapshot } from "./types.js";

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
  private stateStore?: StateStore;
  private pump?: EnvelopePump;
  private actions: ActionExecutor | undefined;
  private abort: AbortController | undefined;
  private stream: Promise<void> | undefined;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    private readonly dryRun = false,
  ) {}

  async start(): Promise<void> {
    if (this.abort) throw new Error("bridge is already started");
    const currentSnapshot = await snapshot(this.config);
    const stateStore = await StateStore.open(this.config.statePath, this.config.projectId);
    if (Number(stateStore.state.cursor) > Number(currentSnapshot.cursor)) {
      throw new Error("bridge cursor is ahead of the server snapshot");
    }
    this.stateStore = stateStore;
    const codex = new CodexClient(this.config, this.logger, this.dryRun);
    const actions = new ActionExecutor(this.config, stateStore, codex, this.logger);
    this.actions = actions;
    if (!stateStore.state.supervisor_thread_id) {
      const result = await codex.startSupervisor(supervisorBrief(currentSnapshot));
      if (!result.threadId) throw new Error("supervisor JSONL did not contain thread.started");
      stateStore.state.supervisor_thread_id = result.threadId;
      if (!stateStore.existed) stateStore.state.cursor = currentSnapshot.cursor;
      await stateStore.save();
      await actions.execute(parseSupervisorDecision(result.stdout, this.logger));
      this.logger.info(`supervisor thread ${result.threadId} persisted`);
    }
    this.pump = new EnvelopePump(
      async (events) => {
        const threadId = stateStore.state.supervisor_thread_id;
        if (!threadId) throw new Error("supervisor thread is unavailable");
        const envelopes = events.map(eventEnvelope);
        const payload = JSON.stringify(envelopes.length === 1 ? envelopes[0] : envelopes);
        const result = await codex.resumeSupervisor(threadId, payload);
        await actions.execute(parseSupervisorDecision(result.stdout, this.logger));
      },
      async (cursor) => {
        stateStore.state.cursor = cursor;
        await stateStore.save();
      },
      this.logger,
    );
    this.abort = new AbortController();
    this.stream = streamEvents(
      this.config,
      stateStore.state.cursor,
      this.abort.signal,
      (event: MissionEvent) => this.pump?.enqueue(event),
      this.logger,
    );
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.stream;
    await this.pump?.whenIdle();
    this.actions?.stop();
    this.abort = undefined;
    this.stream = undefined;
    this.actions = undefined;
  }

  async whenIdle(): Promise<void> {
    await this.pump?.whenIdle();
  }

  getState(): BridgeState | undefined {
    return this.stateStore ? structuredClone(this.stateStore.state) : undefined;
  }
}
