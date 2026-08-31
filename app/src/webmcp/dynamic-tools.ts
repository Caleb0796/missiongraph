export type DynamicRegistrationTier =
  | 'abort-controller'
  | 'provide-context'
  | 'none'

export interface NamedTool {
  name: string
}

export interface DynamicRegistrationTarget<T extends NamedTool> {
  registerTool: (
    tool: T,
    options?: { signal?: AbortSignal },
  ) => Promise<void> | void
  provideContext?: (context: { tools: T[] }) => Promise<void> | void
}

export interface InspectableRegistrationTarget<T extends NamedTool>
  extends DynamicRegistrationTarget<T> {
  getTools: () => Promise<NamedTool[]>
}

export interface ExecutableRegistrationTarget<T extends NamedTool> {
  executeTool: (
    tool: T,
    input: string | Record<string, unknown>,
  ) => Promise<string | null>
}

export interface DynamicToolStatus {
  degraded: boolean
  error?: unknown
}

interface DynamicToolControllerOptions {
  maxAttempts?: number
  delay?: (milliseconds: number) => Promise<void>
  onStatus?: (status: DynamicToolStatus) => void
}

const syncCancelled = Symbol('dynamic tool sync cancelled')

function uniqueTools<T extends NamedTool>(tools: T[]) {
  return [...new Map(tools.map((tool) => [tool.name, tool])).values()]
}

async function waitForToolPresence<T extends NamedTool>(
  target: InspectableRegistrationTarget<T>,
  name: string,
  expected: boolean,
  delay: (milliseconds: number) => Promise<void>,
) {
  for (const milliseconds of [0, 10, 50]) {
    if (milliseconds > 0) await delay(milliseconds)
    const present = (await target.getTools()).some((tool) => tool.name === name)
    if (present === expected) return true
  }
  return false
}

function normalizeExecutionResult(result: string | null) {
  if (result === null) return null
  try {
    const parsed = JSON.parse(result) as unknown
    return typeof parsed === 'string' ? parsed : result
  } catch {
    return result
  }
}

export async function executeRegisteredTool<T extends NamedTool>(
  runtime: { modelContext: ExecutableRegistrationTarget<T> },
  tool: T,
  inputs: Record<string, unknown>,
) {
  try {
    return normalizeExecutionResult(
      await runtime.modelContext.executeTool(tool, JSON.stringify(inputs)),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/WebMCP executeTool requires an object input/i.test(message)) {
      throw error
    }
    return normalizeExecutionResult(
      await runtime.modelContext.executeTool(tool, inputs),
    )
  }
}

export async function detectDynamicRegistrationTier<T extends NamedTool>(
  target: InspectableRegistrationTarget<T>,
  probe: T,
  delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)),
): Promise<DynamicRegistrationTier> {
  const existing = (await target.getTools()).some(
    (tool) => tool.name === probe.name,
  )
  if (existing) {
    return typeof target.provideContext === 'function' ? 'provide-context' : 'none'
  }

  const controller = new AbortController()
  try {
    await target.registerTool(probe, { signal: controller.signal })
    const registered = await waitForToolPresence(
      target,
      probe.name,
      true,
      delay,
    )
    if (!registered) {
      throw new Error(`WebMCP registered ${probe.name} but getTools() did not expose it.`)
    }

    controller.abort()
    const unregistered = await waitForToolPresence(
      target,
      probe.name,
      false,
      delay,
    )
    if (unregistered) return 'abort-controller'
    return typeof target.provideContext === 'function'
      ? 'provide-context'
      : 'none'
  } catch (error) {
    controller.abort()
    throw error
  }
}

export class DynamicToolController<T extends NamedTool> {
  private latest: T[] = []
  private appliedSignature = '\u0001'
  private requestedRevision = 0
  private appliedRevision = 0
  private readonly dynamicControllers = new Map<string, AbortController>()
  private readonly appliedTools = new Map<string, T>()
  private syncing: Promise<void> | null = null
  private disposePromise: Promise<void> | null = null
  private readonly retryCancellations = new Set<() => void>()
  private generation = 0
  private disposed = false
  private degraded = false
  private readonly target: DynamicRegistrationTarget<T>
  private readonly tier: DynamicRegistrationTier
  private readonly coreTools: T[]
  private readonly maxAttempts: number
  private readonly delay: (milliseconds: number) => Promise<void>
  private readonly onStatus: (status: DynamicToolStatus) => void

  constructor(
    target: DynamicRegistrationTarget<T>,
    tier: DynamicRegistrationTier,
    coreTools: T[],
    options: DynamicToolControllerOptions = {},
  ) {
    this.target = target
    this.tier = tier
    this.coreTools = coreTools
    this.maxAttempts = options.maxAttempts ?? 3
    this.delay =
      options.delay ??
      ((milliseconds) =>
        new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)))
    this.onStatus = options.onStatus ?? (() => undefined)
  }

  update(tools: T[], retryDegraded = false) {
    if (this.disposed) return this.disposePromise ?? Promise.resolve()
    this.latest = uniqueTools(tools)
    this.requestedRevision++
    if (this.degraded && !retryDegraded) return Promise.resolve()
    if (this.degraded) {
      this.degraded = false
      this.onStatus({ degraded: false })
    }
    return this.startSync()
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.generation++
    this.retryCancellations.forEach((cancel) => cancel())
    this.retryCancellations.clear()
    this.disposePromise = this.finishDisposal()
    return this.disposePromise
  }

  private startSync() {
    if (this.syncing) return this.syncing
    const generation = this.generation
    const syncing = this.sync(generation).finally(() => {
      if (this.syncing === syncing) this.syncing = null
    })
    this.syncing = syncing
    return this.syncing
  }

  private async finishDisposal() {
    await this.syncing
    this.dynamicControllers.forEach((controller) => controller.abort())
    this.dynamicControllers.clear()
    this.appliedTools.clear()
    if (this.tier === 'provide-context') {
      await this.target.provideContext?.({ tools: uniqueTools(this.coreTools) })
    }
  }

  private isCurrent(generation: number) {
    return !this.disposed && generation === this.generation
  }

  private async sync(generation: number) {
    while (
      this.isCurrent(generation) &&
      this.appliedRevision !== this.requestedRevision
    ) {
      const revision = this.requestedRevision
      const tools = this.latest
      const signature = tools.map((tool) => tool.name).join('\u0000')
      try {
        if (signature !== this.appliedSignature) {
          await this.apply(tools, generation)
          if (!this.isCurrent(generation)) return
          this.appliedSignature = signature
        }
        this.appliedRevision = revision
      } catch (error) {
        if (error === syncCancelled || !this.isCurrent(generation)) return
        this.degraded = true
        this.appliedRevision = this.requestedRevision
        this.onStatus({ degraded: true, error })
        return
      }
    }
  }

  private async retry(
    operation: () => Promise<void> | void,
    generation: number,
  ) {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (!this.isCurrent(generation)) throw syncCancelled
      try {
        await operation()
        if (!this.isCurrent(generation)) throw syncCancelled
        return
      } catch (error) {
        if (error === syncCancelled || !this.isCurrent(generation)) {
          throw syncCancelled
        }
        lastError = error
        if (attempt < this.maxAttempts) {
          await this.waitForRetry(50 * 2 ** (attempt - 1), generation)
        }
      }
    }
    throw lastError
  }

  private waitForRetry(milliseconds: number, generation: number) {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        this.retryCancellations.delete(cancel)
        if (error) reject(error)
        else resolve()
      }
      const cancel = () => finish(syncCancelled)
      this.retryCancellations.add(cancel)
      void this.delay(milliseconds).then(
        () => finish(),
        (error: unknown) => finish(error),
      )
      if (!this.isCurrent(generation)) cancel()
    })
  }

  private async apply(tools: T[], generation: number) {
    if (this.tier === 'none') return
    if (this.tier === 'provide-context') {
      await this.retry(
        () =>
          this.target.provideContext?.({
            tools: uniqueTools([...this.coreTools, ...tools]),
          }),
        generation,
      )
      return
    }

    const nextByName = new Map(tools.map((tool) => [tool.name, tool]))
    for (const [name, controller] of this.dynamicControllers) {
      if (nextByName.has(name)) continue
      controller.abort()
      this.dynamicControllers.delete(name)
      this.appliedTools.delete(name)
    }
    for (const tool of tools) {
      if (this.appliedTools.has(tool.name)) continue
      let registeredController: AbortController | null = null
      await this.retry(
        async () => {
          const controller = new AbortController()
          try {
            await this.target.registerTool(tool, { signal: controller.signal })
            if (!this.isCurrent(generation)) {
              controller.abort()
              throw syncCancelled
            }
            registeredController = controller
          } catch (error) {
            controller.abort()
            throw error
          }
        },
        generation,
      )
      this.dynamicControllers.set(tool.name, registeredController!)
      this.appliedTools.set(tool.name, tool)
    }
  }
}
