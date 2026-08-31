import { TransportError } from '../transport/client'
import { toolCursorForProject } from '../transport/client-logic'
import { useMissionStore } from '../store/mission-store'
import { DynamicToolController } from './dynamic-tools'

export type ModelContextNamespace = 'document' | 'navigator'
export type DynamicToolsTier = 'abort-controller' | 'provide-context' | 'none'

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
  provideContext?: (context: {
    tools: ModelContextTool[]
  }) => Promise<void> | void
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

export interface ToolOutcome {
  [key: string]: unknown
  data?: unknown
  error?: { code: string; message: string }
  preview?: {
    op_token: string
    blast_radius: { stale: string[]; pausing: string[] }
    proposal?: {
      children: { id: string; title: string }[]
      edge_remap: {
        edge_id: string
        upstream: string
        upstream_title: string
        downstream: string
        downstream_title: string
        kind: 'depends' | 'conflicts'
      }[]
    }
  }
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, boolean>
  execute: (
    inputs: Record<string, unknown>,
    options: ToolExecuteOptions,
  ) => ToolOutcome | Promise<ToolOutcome>
}

export interface WebMcpRuntime {
  modelContext: ModelContext
  namespace: ModelContextNamespace
}

const helloMissionGraph: ToolDefinition = {
  name: 'hello_missiongraph',
  description:
    'Report MissionGraph WebMCP compatibility details for this browser.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  execute() {
    const runtime = getWebMcpRuntime()
    return {
      ts: new Date().toISOString(),
      env: {
        ua: navigator.userAgent,
        api: runtime?.namespace ?? 'document',
      },
    }
  },
}

let initialization: Promise<RegistryStatus> | undefined
let definitions: ToolDefinition[] = [helloMissionGraph]
let coreDefinitions: ToolDefinition[] = [helloMissionGraph]
let contextualDefinitions: ToolDefinition[] = []
let currentContextualDefinitions: () => ToolDefinition[] = () => []
let clientCursor: { projectId: string | null; cursor: string } | null = null
let dynamicController: DynamicToolController<ModelContextTool> | null = null
let unsubscribeContext: (() => void) | null = null

export function getWebMcpRuntime(): WebMcpRuntime | null {
  if (document.modelContext) {
    return { modelContext: document.modelContext, namespace: 'document' }
  }
  if (navigator.modelContext) {
    return { modelContext: navigator.modelContext, namespace: 'navigator' }
  }
  return null
}

function errorShape(error: unknown) {
  if (error instanceof TransportError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof Error) {
    return { code: 'invalid_input', message: error.message }
  }
  return { code: 'tool_error', message: String(error) }
}

async function executeDefinition(
  definition: ToolDefinition,
  inputs: Record<string, unknown>,
  options: ToolExecuteOptions,
) {
  const storeBefore = useMissionStore.getState()
  const explicitSince =
    definition.name === 'graph_digest' && typeof inputs.since === 'string'
      ? inputs.since
      : null
  const since =
    explicitSince ??
    toolCursorForProject(
      clientCursor,
      storeBefore.projectId,
      storeBefore.cursor,
    )
  let outcome: ToolOutcome
  try {
    outcome = await definition.execute(inputs, options)
  } catch (error) {
    outcome = { error: errorShape(error) }
  }
  const storeAfter = useMissionStore.getState()
  const projectChanged = storeAfter.projectId !== storeBefore.projectId
  const changes = projectChanged
    ? []
    : storeAfter.changes
        .filter((change) => change.seq > Number(since))
        .slice(-50)
  clientCursor = {
    projectId: storeAfter.projectId,
    cursor: projectChanged ? '0' : storeAfter.cursor,
  }
  return JSON.stringify({
    ok: !outcome.error,
    ...outcome,
    cursor: storeAfter.cursor,
    changes_since: changes,
  })
}

function wrapTool(definition: ToolDefinition): ModelContextTool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: definition.annotations,
    execute(inputs, options) {
      return executeDefinition(definition, inputs, options)
    },
  }
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function bootstrapWebMcp(): Promise<RegistryStatus> {
  const runtime = getWebMcpRuntime()
  if (!runtime) {
    console.info('[MissionGraph] WebMCP unavailable; dynamic-tools tier=none')
    return { namespace: null, dynamicToolsTier: 'none' }
  }

  const controller = new AbortController()
  controller.abort()
  let registrationError: unknown
  try {
    await runtime.modelContext.registerTool(wrapTool(helloMissionGraph), {
      signal: controller.signal,
    })
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
  } else if (typeof runtime.modelContext.provideContext === 'function') {
    dynamicToolsTier = 'provide-context'
  } else {
    dynamicToolsTier = 'none'
  }

  const coreTools = coreDefinitions.map(wrapTool)
  if (dynamicToolsTier !== 'provide-context') {
    const existing = new Set(registeredTools.map((tool) => tool.name))
    const initialTools =
      dynamicToolsTier === 'none'
        ? [...coreTools, ...contextualDefinitions.map(wrapTool)]
        : coreTools
    for (const tool of initialTools) {
      if (!existing.has(tool.name)) await runtime.modelContext.registerTool(tool)
      existing.add(tool.name)
    }
  }

  dynamicController = new DynamicToolController(
    runtime.modelContext,
    dynamicToolsTier,
    coreTools,
    {
      onStatus(status) {
        useMissionStore.getState().setContextualToolsDegraded(status.degraded)
        if (status.degraded) {
          console.warn(
            '[MissionGraph] contextual WebMCP tools degraded after 3 registration attempts; retrying on the next selection change.',
            status.error,
          )
        }
      },
    },
  )
  await refreshContextualTools(true)
  unsubscribeContext = useMissionStore.subscribe((state, previous) => {
    if (
      state.selectedId !== previous.selectedId ||
      state.nodes !== previous.nodes ||
      state.edges !== previous.edges
    ) {
      void refreshContextualTools(state.selectedId !== previous.selectedId)
    }
  })

  console.info(
    `[MissionGraph] WebMCP namespace=${runtime.namespace}; dynamic-tools tier=${dynamicToolsTier}`,
  )
  return { namespace: runtime.namespace, dynamicToolsTier }
}

export interface ContextualToolConfiguration {
  all: ToolDefinition[]
  current: () => ToolDefinition[]
}

export function initializeWebMcp(
  tools: ToolDefinition[] = [],
  contextual: ContextualToolConfiguration = { all: [], current: () => [] },
) {
  coreDefinitions = [helloMissionGraph, ...tools]
  contextualDefinitions = contextual.all
  currentContextualDefinitions = contextual.current
  definitions = [...coreDefinitions, ...contextualDefinitions]
  initialization ??= bootstrapWebMcp()
  return initialization
}

export async function refreshContextualTools(retryDegraded = false) {
  if (!dynamicController) return
  const unique = [
    ...new Map(
      currentContextualDefinitions().map((definition) => [
        definition.name,
        definition,
      ]),
    ).values(),
  ]
  await dynamicController.update(unique.map(wrapTool), retryDegraded)
}

export function disposeWebMcpRegistry() {
  unsubscribeContext?.()
  unsubscribeContext = null
  dynamicController?.dispose()
  dynamicController = null
  useMissionStore.getState().setContextualToolsDegraded(false)
}

export async function executeToolDirect(
  name: string,
  inputs: Record<string, unknown>,
) {
  const definition = definitions.find((tool) => tool.name === name)
  if (!definition) throw new Error(`Tool ${name} is not registered.`)
  return executeDefinition(definition, inputs, {
    signal: new AbortController().signal,
  })
}
