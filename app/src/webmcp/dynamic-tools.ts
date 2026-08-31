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

export interface DynamicToolStatus {
  degraded: boolean
  error?: unknown
}

interface DynamicToolControllerOptions {
  maxAttempts?: number
  delay?: (milliseconds: number) => Promise<void>
  onStatus?: (status: DynamicToolStatus) => void
}

function uniqueTools<T extends NamedTool>(tools: T[]) {
  return [...new Map(tools.map((tool) => [tool.name, tool])).values()]
}

export class DynamicToolController<T extends NamedTool> {
  private latest: T[] = []
  private appliedSignature = '\u0001'
  private requestedRevision = 0
  private appliedRevision = 0
  private readonly dynamicControllers = new Map<string, AbortController>()
  private readonly appliedTools = new Map<string, T>()
  private syncing: Promise<void> | null = null
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
    this.dynamicControllers.forEach((controller) => controller.abort())
    this.dynamicControllers.clear()
    this.appliedTools.clear()
  }

  private startSync() {
    this.syncing ??= this.sync().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async sync() {
    while (this.appliedRevision !== this.requestedRevision) {
      const revision = this.requestedRevision
      const tools = this.latest
      const signature = tools.map((tool) => tool.name).join('\u0000')
      try {
        if (signature !== this.appliedSignature) {
          await this.apply(tools)
          this.appliedSignature = signature
        }
        this.appliedRevision = revision
      } catch (error) {
        this.degraded = true
        this.appliedRevision = this.requestedRevision
        this.onStatus({ degraded: true, error })
        return
      }
    }
  }

  private async retry(operation: () => Promise<void> | void) {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await operation()
        return
      } catch (error) {
        lastError = error
        if (attempt < this.maxAttempts) {
          await this.delay(50 * 2 ** (attempt - 1))
        }
      }
    }
    throw lastError
  }

  private async apply(tools: T[]) {
    if (this.tier === 'none') return
    if (this.tier === 'provide-context') {
      await this.retry(() =>
        this.target.provideContext?.({
          tools: uniqueTools([...this.coreTools, ...tools]),
        }),
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
      await this.retry(async () => {
        const controller = new AbortController()
        try {
          await this.target.registerTool(tool, { signal: controller.signal })
          registeredController = controller
        } catch (error) {
          controller.abort()
          throw error
        }
      })
      this.dynamicControllers.set(tool.name, registeredController!)
      this.appliedTools.set(tool.name, tool)
    }
  }
}
