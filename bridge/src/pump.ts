import { structuralEventTypes, type Logger, type MissionEvent } from "./types.js";

export class EnvelopePump {
  private readonly queue: MissionEvent[] = [];
  private readonly queuedSequences = new Set<number>();
  private draining = false;
  private scheduled = false;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly deliver: (events: MissionEvent[]) => Promise<void>,
    private readonly commitCursor: (cursor: string) => Promise<void>,
    private readonly logger: Logger,
  ) {}

  enqueue(event: MissionEvent): void {
    if (this.queuedSequences.has(event.seq)) return;
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

  async whenIdle(): Promise<void> {
    if (!this.draining && !this.scheduled && this.queue.length === 0) return;
    await new Promise<void>((resolvePromise) => this.idleWaiters.push(resolvePromise));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0);
        const structural = batch.filter((event) => structuralEventTypes.has(event.type));
        try {
          if (structural.length > 0) await this.deliver(structural);
          const cursor = String(batch.at(-1)?.seq ?? 0);
          await this.commitCursor(cursor);
          for (const event of batch) this.queuedSequences.delete(event.seq);
        } catch (error) {
          this.queue.unshift(...batch);
          this.logger.error(`envelope delivery failed; cursor retained for retry: ${error instanceof Error ? error.message : String(error)}`);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
        }
      }
    } finally {
      this.draining = false;
      for (const resolvePromise of this.idleWaiters.splice(0)) resolvePromise();
      if (this.queue.length > 0 && !this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => {
          this.scheduled = false;
          void this.drain();
        });
      }
    }
  }
}
