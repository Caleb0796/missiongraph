export type RegistryLifecycleStatus<T extends object> =
  | ({ state: 'active' } & T)
  | { state: 'waiting' }
  | { state: 'unsupported' }

type Cleanup = () => Promise<void> | void

export class RegistrationScope {
  private cleanups: Cleanup[] = []

  addCleanup(cleanup: Cleanup) {
    this.cleanups.push(cleanup)
  }

  async dispose() {
    const cleanups = this.cleanups.splice(0).reverse()
    let failure: unknown
    for (const cleanup of cleanups) {
      try {
        await cleanup()
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) throw failure
  }
}

export type MissionClientReadiness =
  | { state: 'ready' }
  | { state: 'failed'; error: unknown }
  | { state: 'pending' }

export async function missionClientReadiness(
  promise: Promise<unknown>,
): Promise<MissionClientReadiness> {
  let readiness: MissionClientReadiness = { state: 'pending' }
  void promise.then(
    () => {
      readiness = { state: 'ready' }
    },
    (error: unknown) => {
      readiness = { state: 'failed', error }
    },
  )
  await Promise.resolve()
  return readiness as MissionClientReadiness
}

interface RegistryLifecycleOptions<Runtime, Active extends object> {
  getRuntime: () => Runtime | null
  bootstrap: (
    runtime: Runtime,
    scope: RegistrationScope,
  ) => Promise<Active>
  onBackgroundError?: (error: unknown) => void
}

const FAST_WINDOW_MS = 5_000
const FAST_DELAYS_MS = [50, 100, 200, 400, 500] as const
const SLOW_DELAY_MS = 2_000

export class RegistryLifecycle<Runtime, Active extends object> {
  private readonly getRuntime: () => Runtime | null
  private readonly bootstrap: (
    runtime: Runtime,
    scope: RegistrationScope,
  ) => Promise<Active>
  private readonly onBackgroundError: (error: unknown) => void
  private readonly listeners = new Set<() => void>()
  private status: RegistryLifecycleStatus<Active> = { state: 'waiting' }
  private initialization: Promise<RegistryLifecycleStatus<Active>> | null = null
  private activeScope: RegistrationScope | null = null
  private pendingScope: RegistrationScope | null = null
  private pollTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  private fastDelayIndex = 0
  private pollElapsedMs = 0
  private generation = 0

  constructor(options: RegistryLifecycleOptions<Runtime, Active>) {
    this.getRuntime = options.getRuntime
    this.bootstrap = options.bootstrap
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined)
  }

  getStatus = () => this.status

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  initialize() {
    if (this.status.state === 'active' && this.initialization) {
      return this.initialization
    }
    if (this.initialization) return this.initialization

    const generation = this.generation
    const initialization = this.attempt(generation)
    this.initialization = initialization
    void initialization.then(
      (status) => {
        if (
          this.initialization === initialization &&
          status.state !== 'active'
        ) {
          this.initialization = null
        }
      },
      () => {
        if (this.initialization === initialization) this.initialization = null
        if (generation === this.generation) this.ensurePoller()
      },
    )
    return initialization
  }

  recheck() {
    if (this.status.state === 'active') return this.initialize()
    this.clearPoller()
    this.fastDelayIndex = 0
    this.pollElapsedMs = 0
    const current = this.initialization
    if (!current) return this.initialize()
    return current.then(
      () => this.initialize(),
      () => this.initialize(),
    )
  }

  async dispose() {
    this.generation++
    this.clearPoller()
    this.fastDelayIndex = 0
    this.pollElapsedMs = 0
    this.initialization = null
    const scopes = [this.pendingScope, this.activeScope].filter(
      (scope): scope is RegistrationScope => scope !== null,
    )
    this.pendingScope = null
    this.activeScope = null
    const cleanupResults = await Promise.allSettled(
      scopes.map((scope) => scope.dispose()),
    )
    this.setStatus({ state: 'waiting' })
    const failed = cleanupResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failed) throw failed.reason
  }

  private async attempt(
    generation: number,
  ): Promise<RegistryLifecycleStatus<Active>> {
    const runtime = this.getRuntime()
    if (!runtime) {
      this.setStatus({ state: 'waiting' })
      this.ensurePoller()
      return this.status
    }

    const scope = new RegistrationScope()
    this.pendingScope = scope
    try {
      const active = await this.bootstrap(runtime, scope)
      if (generation !== this.generation) {
        await scope.dispose()
        return { state: 'waiting' }
      }
      this.pendingScope = null
      this.activeScope = scope
      this.clearPoller()
      const status = { state: 'active', ...active } as const
      this.setStatus(status)
      return status
    } catch (error) {
      try {
        await scope.dispose()
      } catch (cleanupError) {
        this.onBackgroundError(cleanupError)
      }
      if (this.pendingScope === scope) this.pendingScope = null
      if (generation === this.generation) this.setStatus({ state: 'waiting' })
      throw error
    }
  }

  private ensurePoller() {
    if (this.pollTimer !== null || this.status.state === 'active') return
    const delay = this.nextPollDelay()
    const generation = this.generation
    this.pollTimer = globalThis.setTimeout(() => {
      this.pollTimer = null
      if (generation !== this.generation) return
      void this.initialize().catch((error) => {
        this.onBackgroundError(error)
      })
    }, delay)
  }

  private nextPollDelay() {
    if (this.pollElapsedMs >= FAST_WINDOW_MS) return SLOW_DELAY_MS
    const backoff =
      FAST_DELAYS_MS[
        Math.min(this.fastDelayIndex, FAST_DELAYS_MS.length - 1)
      ]
    this.fastDelayIndex++
    const delay = Math.min(backoff, FAST_WINDOW_MS - this.pollElapsedMs)
    this.pollElapsedMs += delay
    return delay
  }

  private clearPoller() {
    if (this.pollTimer === null) return
    globalThis.clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  private setStatus(status: RegistryLifecycleStatus<Active>) {
    if (this.status.state === status.state) return
    this.status = status
    this.listeners.forEach((listener) => listener())
  }
}
