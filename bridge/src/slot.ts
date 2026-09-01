export interface ExecutionLease {
  readonly owner: string;
  release(): void;
}

interface Waiter {
  owner: string;
  resolve(lease: ExecutionLease): void;
}

export class ExecutionSlot {
  private currentOwner: string | undefined;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly enabled = true) {}

  get owner(): string | undefined {
    return this.currentOwner;
  }

  tryAcquire(owner: string): ExecutionLease | undefined {
    if (!this.enabled) return { owner, release: () => undefined };
    if (this.currentOwner !== undefined || this.waiters.length > 0) return undefined;
    this.currentOwner = owner;
    return this.lease(owner);
  }

  async acquire(owner: string): Promise<ExecutionLease> {
    const immediate = this.tryAcquire(owner);
    if (immediate) return immediate;
    return await new Promise<ExecutionLease>((resolve) => this.waiters.push({ owner, resolve }));
  }

  private lease(owner: string): ExecutionLease {
    let released = false;
    return {
      owner,
      release: () => {
        if (released) return;
        released = true;
        if (this.currentOwner !== owner) return;
        const next = this.waiters.shift();
        if (!next) {
          this.currentOwner = undefined;
          return;
        }
        this.currentOwner = next.owner;
        next.resolve(this.lease(next.owner));
      },
    };
  }
}
