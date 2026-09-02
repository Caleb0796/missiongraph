import { TransportError } from '../transport/client'
import { toolCursorForProject } from '../transport/client-logic'
import { useMissionStore } from '../store/mission-store'
import {
  detectDynamicRegistrationTier,
  DynamicToolController,
  type InspectableRegistrationTarget,
} from './dynamic-tools'
import {
  RegistrationScope,
  RegistryLifecycle,
  missionClientReadiness,
  type RegistryLifecycleStatus,
} from './registry-lifecycle'
import {
  contentSafeAnnotations,
  contentSafeEnvelope,
} from './content-policy'
import { capabilityRequiredNextStep } from './agent-guidance'

export { executeRegisteredTool } from './dynamic-tools'

export type ModelContextNamespace = 'document' | 'navigator'
export type DynamicToolsTier = 'abort-controller' | 'provide-context' | 'none'

export type RegistryStatus = RegistryLifecycleStatus<{
  namespace: ModelContextNamespace
  dynamicToolsTier: DynamicToolsTier
}>

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
  executeTool: (
    tool: RegisteredTool,
    input: string | Record<string, unknown>,
  ) => Promise<string | null>
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

let definitions: ToolDefinition[] = [helloMissionGraph]
let coreDefinitions: ToolDefinition[] = [helloMissionGraph]
let contextualDefinitions: ToolDefinition[] = []
let currentContextualDefinitions: () => ToolDefinition[] = () => []
let clientCursor: { projectId: string | null; cursor: string } | null = null
let dynamicController: DynamicToolController<ModelContextTool> | null = null
let unsubscribeContext: (() => void) | null = null
let executionReady: Promise<unknown> | null = null

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
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
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
    if (definition !== helloMissionGraph) await requireMissionClient()
    outcome = await definition.execute(inputs, options)
  } catch (error) {
    const shape = errorShape(error)
    const nextStep =
      shape.code === 'capability_required'
        ? capabilityRequiredNextStep(
            definition.name,
            useMissionStore.getState().cursor,
          )
        : undefined
    outcome = {
      error: shape,
      ...(nextStep ? { data: { next_step: nextStep } } : {}),
    }
  }
  const storeAfter = useMissionStore.getState()
  const projectChanged = storeAfter.projectId !== storeBefore.projectId
  const changes = projectChanged
    ? []
    : storeAfter.changes
        .filter((change) => change.seq > Number(since))
  const safe = contentSafeEnvelope(outcome, changes)
  const boundedOutcome = safe.outcome as ToolOutcome
  clientCursor = {
    projectId: storeAfter.projectId,
    cursor: projectChanged ? '0' : storeAfter.cursor,
  }
  return JSON.stringify({
    ok: !boundedOutcome.error,
    ...boundedOutcome,
    cursor: storeAfter.cursor,
    changes_since: safe.changes,
    content_policy: safe.contentPolicy,
  })
}

async function requireMissionClient() {
  if (!executionReady) return
  const result = await missionClientReadiness(executionReady)
  if (result.state === 'pending') {
    throw new TransportError(
      'mission_connecting',
      'MissionGraph is still connecting to the mission server. Try again shortly.',
    )
  }
  if (result.state === 'failed') {
    const message =
      result.error instanceof Error
        ? result.error.message
        : String(result.error)
    throw new TransportError(
      'mission_connection_failed',
      `MissionGraph could not connect to the mission server: ${message}`,
    )
  }
}

function wrapTool(definition: ToolDefinition): ModelContextTool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: contentSafeAnnotations(definition.annotations),
    execute(inputs, options) {
      return executeDefinition(definition, inputs, options)
    },
  }
}

function createRegistrationTarget(
  runtime: WebMcpRuntime,
): InspectableRegistrationTarget<ModelContextTool> {
  const target: InspectableRegistrationTarget<ModelContextTool> = {
    getTools: () => runtime.modelContext.getTools(),
    registerTool(tool, options) {
      if (
        typeof document !== 'undefined' &&
        runtime.namespace === 'document' &&
        document.modelContext &&
        document.modelContext === runtime.modelContext
      ) {
        if (options) {
          return document.modelContext.registerTool({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            execute: tool.execute,
            annotations: tool.annotations,
          }, options)
        }
        return document.modelContext.registerTool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          execute: tool.execute,
          annotations: tool.annotations,
        })
      }
      return options
        ? runtime.modelContext.registerTool(tool, options)
        : runtime.modelContext.registerTool(tool)
    },
  }
  if (typeof runtime.modelContext.provideContext === 'function') {
    target.provideContext = (context) =>
      runtime.modelContext.provideContext?.(context)
  }
  return target
}

function registrationErrorMessage(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  const message = String(error)
  return message === '[object Object]'
    ? 'WebMCP registration failed with an opaque browser error.'
    : message
}

async function bootstrapWebMcp(
  runtime: WebMcpRuntime,
  scope: RegistrationScope,
) {
  const registrationTarget = createRegistrationTarget(runtime)
  const dynamicToolsTier = await detectDynamicRegistrationTier(
    registrationTarget,
    wrapTool(helloMissionGraph),
  )
  const registeredTools = await runtime.modelContext.getTools()
  if (dynamicToolsTier === 'provide-context') {
    scope.addCleanup(() =>
      runtime.modelContext.provideContext?.({ tools: [] }),
    )
  }

  const coreTools = coreDefinitions.map(wrapTool)
  if (dynamicToolsTier !== 'provide-context') {
    const existing = new Set(registeredTools.map((tool) => tool.name))
    const initialTools =
      dynamicToolsTier === 'none'
        ? [...coreTools, ...contextualDefinitions.map(wrapTool)]
        : coreTools
    for (const tool of initialTools) {
      if (!existing.has(tool.name)) {
        if (dynamicToolsTier === 'abort-controller') {
          const registrationController = new AbortController()
          scope.addCleanup(() => registrationController.abort())
          await registrationTarget.registerTool(tool, {
            signal: registrationController.signal,
          })
        } else {
          await registrationTarget.registerTool(tool)
        }
      }
      existing.add(tool.name)
    }
  }

  const nextDynamicController = new DynamicToolController(
    registrationTarget,
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
  scope.addCleanup(() => nextDynamicController.dispose())
  dynamicController = nextDynamicController
  scope.addCleanup(() => {
    if (dynamicController === nextDynamicController) dynamicController = null
  })
  const nextUnsubscribeContext = useMissionStore.subscribe((state, previous) => {
    if (
      state.selectedId !== previous.selectedId ||
      state.nodes !== previous.nodes ||
      state.edges !== previous.edges
    ) {
      void refreshContextualTools(state.selectedId !== previous.selectedId)
    }
  })
  unsubscribeContext = nextUnsubscribeContext
  scope.addCleanup(nextUnsubscribeContext)
  scope.addCleanup(() => {
    if (unsubscribeContext === nextUnsubscribeContext) unsubscribeContext = null
  })
  const contextualTools = [
    ...new Map(
      currentContextualDefinitions().map((definition) => [
        definition.name,
        definition,
      ]),
    ).values(),
  ]
  await nextDynamicController.update(contextualTools.map(wrapTool), true)
  await refreshContextualTools(true)

  console.info(
    `[MissionGraph] WebMCP namespace=${runtime.namespace}; dynamic-tools tier=${dynamicToolsTier}`,
  )
  return { namespace: runtime.namespace, dynamicToolsTier }
}

const registryLifecycle = new RegistryLifecycle({
  getRuntime: getWebMcpRuntime,
  bootstrap: bootstrapWebMcp,
  errorMessage: registrationErrorMessage,
  onBackgroundError(error) {
    console.warn(
      '[MissionGraph] WebMCP registration failed; waiting to retry.',
      registrationErrorMessage(error),
    )
  },
})

export interface ContextualToolConfiguration {
  all: ToolDefinition[]
  current: () => ToolDefinition[]
}

export function initializeWebMcp(
  tools: ToolDefinition[] = [],
  contextual: ContextualToolConfiguration = { all: [], current: () => [] },
  options: { executionReady?: Promise<unknown> } = {},
) {
  coreDefinitions = [helloMissionGraph, ...tools]
  contextualDefinitions = contextual.all
  currentContextualDefinitions = contextual.current
  definitions = [...coreDefinitions, ...contextualDefinitions]
  if (options.executionReady) executionReady = options.executionReady
  return registryLifecycle.initialize()
}

export function recheckWebMcp() {
  return registryLifecycle.recheck()
}

export const getWebMcpRegistryStatus = registryLifecycle.getStatus
export const subscribeWebMcpRegistryStatus = registryLifecycle.subscribe

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

export async function disposeWebMcpRegistry() {
  unsubscribeContext?.()
  unsubscribeContext = null
  const activeDynamicController = dynamicController
  dynamicController = null
  try {
    const cleanupResults = await Promise.allSettled([
      activeDynamicController?.dispose() ?? Promise.resolve(),
      registryLifecycle.dispose(),
    ])
    const failed = cleanupResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failed) throw failed.reason
  } finally {
    useMissionStore.getState().setContextualToolsDegraded(false)
    definitions = [helloMissionGraph]
    coreDefinitions = [helloMissionGraph]
    contextualDefinitions = []
    currentContextualDefinitions = () => []
    clientCursor = null
    executionReady = null
  }
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
