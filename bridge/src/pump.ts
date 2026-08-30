import { structuralEventTypes, type Logger, type MissionEvent } from "./types.js";

export interface PreparedDelivery {
  afterCommit(): Promise<void>;
}

export class EnvelopePump {
  private readonly queue: MissionEvent[] = [];
  private readonly queuedSequences = new Set<number>();
  private draining = false;
  private scheduled = false;
  private stopped = false;
  private droppedCount = 0;
  private droppedThrough = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly prepareDelivery: (events: MissionEvent[]) => Promise<PreparedDelivery>,
    private readonly commitCursor: (cursor: string) => Promise<void>,
    private readonly logger: Logger,
    private readonly onDrop: (count: number) => Promise<void> = async () => undefined,
    private readonly capacity = 500,
  ) {}

  enqueue(event: MissionEvent): void {
    if (this.stopped || this.queuedSequences.has(event.seq)) return;
    if (this.queue.length >= this.capacity) {
      if (event.type === "WORKER_LOG") {
        this.recordDrop(event);
        return;
      }
      const logIndex = this.queue.findIndex((queued) => queued.type === "WORKER_LOG");
      if (logIndex >= 0) {
        const [dropped] = this.queue.splice(logIndex, 1);
        if (dropped) {
          this.queuedSequences.delete(dropped.seq);
          this.recordDrop(dropped);
        }
      } else {
        this.recordDrop(event);
        return;
      }
    }
    this.queuedSequences.add(event.seq);
    this.queue.push(event);
    if (!this.scheduled && !this.draining) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        void this.drain();
      });
    }
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.queuedSequences.clear();
    if (!this.draining) this.resolveIdle();
  }

  async whenIdle(): Promise<void> {
    if (!this.draining && !this.scheduled && this.queue.length === 0) return;
    await new Promise<void>((resolvePromise) => this.idleWaiters.push(resolvePromise));
  }

  private recordDrop(event: MissionEvent): void {
    this.droppedCount += 1;
    this.droppedThrough = Math.max(this.droppedThrough, event.seq);
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const batch = this.queue.splice(0);
        const structural = batch.filter(
          (event) => structuralEventTypes.has(event.type) && !(event.type === "JOURNAL_NOTE" && event.actor === "supervisor"),
        );
        const droppedCount = this.droppedCount;
        const droppedThrough = this.droppedThrough;
        this.droppedCount = 0;
        this.droppedThrough = 0;
        let committed = false;
        try {
          const prepared = structural.length > 0
            ? await this.prepareDelivery(structural)
            : { afterCommit: async () => undefined };
          const cursor = String(Math.max(batch.at(-1)?.seq ?? 0, droppedThrough));
          await this.commitCursor(cursor);
          committed = true;
          for (const event of batch) this.queuedSequences.delete(event.seq);
          try {
            if (!this.stopped) {
              await prepared.afterCommit();
              if (droppedCount > 0) await this.onDrop(droppedCount);
            }
          } catch (error) {
            this.logger.error(`post-commit action failed and will not be redelivered: ${error instanceof Error ? error.message : String(error)}`);
          }
        } catch (error) {
          if (!committed && !this.stopped) {
            this.queue.unshift(...batch);
            this.droppedCount += droppedCount;
            this.droppedThrough = Math.max(this.droppedThrough, droppedThrough);
            this.logger.error(`envelope delivery failed; cursor retained for retry: ${error instanceof Error ? error.message : String(error)}`);
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
          }
        }
      }
    } finally {
      this.draining = false;
      this.resolveIdle();
      if (!this.stopped && this.queue.length > 0 && !this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => {
          this.scheduled = false;
          void this.drain();
        });
      }
    }
  }

  private resolveIdle(): void {
    for (const resolvePromise of this.idleWaiters.splice(0)) resolvePromise();
  }
}
