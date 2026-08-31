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

function uniqueTools<T extends NamedTool>(tools: T[]) {
  return [...new Map(tools.map((tool) => [tool.name, tool])).values()]
}

export class DynamicToolController<T extends NamedTool> {
  private latest: T[] = []
  private appliedSignature = '\u0001'
  private requestedRevision = 0
  private appliedRevision = 0
  private dynamicController: AbortController | null = null
  private syncing: Promise<void> | null = null
  private readonly target: DynamicRegistrationTarget<T>
  private readonly tier: DynamicRegistrationTier
  private readonly coreTools: T[]

  constructor(
    target: DynamicRegistrationTarget<T>,
    tier: DynamicRegistrationTier,
    coreTools: T[],
  ) {
    this.target = target
    this.tier = tier
    this.coreTools = coreTools
  }

  update(tools: T[]) {
    this.latest = uniqueTools(tools)
    this.requestedRevision++
    this.startSync()
    return this.syncing
  }

  dispose() {
    this.dynamicController?.abort()
    this.dynamicController = null
  }

  private startSync() {
    this.syncing ??= this.sync().finally(() => {
      this.syncing = null
      if (this.appliedRevision !== this.requestedRevision) this.startSync()
    })
  }

  private async sync() {
    while (this.appliedRevision !== this.requestedRevision) {
      const revision = this.requestedRevision
      const tools = this.latest
      const signature = tools.map((tool) => tool.name).join('\u0000')
      if (signature !== this.appliedSignature) {
        await this.apply(tools)
        this.appliedSignature = signature
      }
      this.appliedRevision = revision
    }
  }

  private async apply(tools: T[]) {
    if (this.tier === 'none') return
    if (this.tier === 'provide-context') {
      await this.target.provideContext?.({
        tools: uniqueTools([...this.coreTools, ...tools]),
      })
      return
    }

    this.dynamicController?.abort()
    const controller = new AbortController()
    this.dynamicController = controller
    try {
      for (const tool of tools) {
        await this.target.registerTool(tool, { signal: controller.signal })
      }
    } catch (error) {
      controller.abort()
      if (this.dynamicController === controller) this.dynamicController = null
      throw error
    }
  }
}
