interface Scheduler {
  setTimeout: (callback: () => void, milliseconds: number) => unknown
  clearTimeout: (timer: unknown) => void
}

export class SettledDebouncer<T> {
  private readonly pending = new Map<
    string,
    { timer: unknown; supersededValue: T; resolve: (value: T) => void }
  >()
  private readonly scheduler: Scheduler

  constructor(scheduler: Scheduler) {
    this.scheduler = scheduler
  }

  schedule(
    key: string,
    delayMs: number,
    supersededValue: T,
    run: () => Promise<T>,
  ) {
    const previous = this.pending.get(key)
    if (previous) {
      this.scheduler.clearTimeout(previous.timer)
      previous.resolve(previous.supersededValue)
    }
    return new Promise<T>((resolve, reject) => {
      const timer = this.scheduler.setTimeout(() => {
        const current = this.pending.get(key)
        if (current?.timer !== timer) return
        this.pending.delete(key)
        run().then(resolve, reject)
      }, delayMs)
      this.pending.set(key, { timer, supersededValue, resolve })
    })
  }
}
