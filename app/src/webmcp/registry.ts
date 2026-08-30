export type ModelContextNamespace = 'document' | 'navigator'
export type DynamicToolsTier =
  | 'abort-controller'
  | 'provide-context'
  | 'none'

export interface RegistryStatus {
  namespace: ModelContextNamespace | null
  dynamicToolsTier: DynamicToolsTier
}

interface RegisteredTool {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
  annotations?: Record<string, boolean>
}

interface ToolExecuteOptions {
  signal: AbortSignal
}

interface ModelContextTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, boolean>
  execute: (
    inputs: Record<string, unknown>,
    options: ToolExecuteOptions,
  ) => Promise<string>
}

interface ModelContext {
  registerTool: (
    tool: ModelContextTool,
    options?: { signal?: AbortSignal },
  ) => Promise<void> | void
  provideContext?: (context: { tools: ModelContextTool[] }) => Promise<void> | void
  getTools: () => Promise<RegisteredTool[]>
  executeTool: (tool: RegisteredTool, input: string) => Promise<string | null>
}

declare global {
  interface Document {
    modelContext?: ModelContext
  }

  interface Navigator {
    modelContext?: ModelContext
  }
}

interface ToolResult {
  ok: boolean
  [key: string]: unknown
}

interface ToolDefinition extends Omit<ModelContextTool, 'execute'> {
  execute: (
    inputs: Record<string, unknown>,
    options: ToolExecuteOptions,
  ) => ToolResult | Promise<ToolResult>
}

export interface WebMcpRuntime {
  modelContext: ModelContext
  namespace: ModelContextNamespace
}

const helloMissionGraph: ToolDefinition = {
  name: 'hello_missiongraph',
  description:
    'Report MissionGraph WebMCP compatibility details for this browser.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  annotations: { readOnlyHint: true },
  execute() {
    const runtime = getWebMcpRuntime()

    return {
      ok: true,
      ts: new Date().toISOString(),
      env: {
        ua: navigator.userAgent,
        api: runtime?.namespace ?? 'document',
      },
    }
  },
}

let initialization: Promise<RegistryStatus> | undefined

export function getWebMcpRuntime(): WebMcpRuntime | null {
  if (document.modelContext) {
    return { modelContext: document.modelContext, namespace: 'document' }
  }

  if (navigator.modelContext) {
    return { modelContext: navigator.modelContext, namespace: 'navigator' }
  }

  return null
}

function wrapTool(definition: ToolDefinition): ModelContextTool {
  return {
    ...definition,
    async execute(inputs, options) {
      const result = await definition.execute(inputs, options)

      return JSON.stringify({
        ...result,
        cursor: '0',
        changes_since: [],
      })
    },
  }
}

export async function registerTool(
  definition: ToolDefinition,
  options?: { signal?: AbortSignal },
) {
  const runtime = getWebMcpRuntime()
  if (!runtime) {
    return false
  }

  await runtime.modelContext.registerTool(wrapTool(definition), options)
  return true
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function bootstrapWebMcp(): Promise<RegistryStatus> {
  const runtime = getWebMcpRuntime()
  if (!runtime) {
    const status: RegistryStatus = {
      namespace: null,
      dynamicToolsTier: 'none',
    }
    console.info('[MissionGraph] WebMCP unavailable; dynamic-tools tier=none')
    return status
  }

  const controller = new AbortController()
  controller.abort()
  let registrationError: unknown

  try {
    await registerTool(helloMissionGraph, { signal: controller.signal })
  } catch (error) {
    registrationError = error
  }

  const registeredTools = await runtime.modelContext.getTools()
  const helloWasRegistered = registeredTools.some(
    (tool) => tool.name === helloMissionGraph.name,
  )
  let dynamicToolsTier: DynamicToolsTier

  if (!helloWasRegistered) {
    if (registrationError && !isAbortError(registrationError)) {
      throw registrationError
    }

    dynamicToolsTier = 'abort-controller'
    await registerTool(helloMissionGraph)
  } else if (typeof runtime.modelContext.provideContext === 'function') {
    dynamicToolsTier = 'provide-context'
  } else {
    dynamicToolsTier = 'none'
  }

  console.info(
    `[MissionGraph] WebMCP namespace=${runtime.namespace}; dynamic-tools tier=${dynamicToolsTier}`,
  )

  return { namespace: runtime.namespace, dynamicToolsTier }
}

export function initializeWebMcp() {
  initialization ??= bootstrapWebMcp()
  return initialization
}
