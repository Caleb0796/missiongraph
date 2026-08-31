import { TransportError } from '../transport/client'
import { toolCursorForProject } from '../transport/client-logic'
import { useMissionStore } from '../store/mission-store'
import {
  detectDynamicRegistrationTier,
  DynamicToolController,
} from './dynamic-tools'

export { executeRegisteredTool } from './dynamic-tools'

export type ModelContextNamespace = 'document' | 'navigator'
export type DynamicToolsTier = 'abort-controller' | 'provide-context' | 'none'

export interface RegistryStatus {
  namespace: ModelContextNamespace | null
  dynamicToolsTier: DynamicToolsTier
}

export type RegistryRuntimeStatus =
  | { state: 'waiting'; error?: string }
  | ({ state: 'active' } & RegistryStatus)

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

let initialization: Promise<RegistryRuntimeStatus> | undefined
let definitions: ToolDefinition[] = [helloMissionGraph]
let coreDefinitions: ToolDefinition[] = [helloMissionGraph]
let contextualDefinitions: ToolDefinition[] = []
let currentContextualDefinitions: () => ToolDefinition[] = () => []
let clientCursor: { projectId: string | null; cursor: string } | null = null
let registryStatus: RegistryRuntimeStatus = { state: 'waiting' }
const registryStatusListeners = new Set<() => void>()
const retryDelays = [100, 200, 400, 800, 1_600, 2_000]
let retryDelayIndex = 0
let retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null
let coreControllers: AbortController[] = []
let clearProvidedContext: (() => Promise<void>) | null = null
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

function setRegistryStatus(status: RegistryRuntimeStatus) {
  if (
    status.state === registryStatus.state &&
    (status.state !== 'active' ||
      (registryStatus.state === 'active' &&
        status.namespace === registryStatus.namespace &&
        status.dynamicToolsTier === registryStatus.dynamicToolsTier)) &&
    (status.state !== 'waiting' ||
      (registryStatus.state === 'waiting' &&
        status.error === registryStatus.error))
  ) {
    return
  }
  registryStatus = status
  registryStatusListeners.forEach((listener) => listener())
}

function clearRetryTimer() {
  if (retryTimer === null) return
  globalThis.clearTimeout(retryTimer)
  retryTimer = null
}

function scheduleWebMcpRetry() {
  if (retryTimer !== null || registryStatus.state === 'active') return
  const delay = retryDelays[Math.min(retryDelayIndex, retryDelays.length - 1)]
  retryDelayIndex++
  retryTimer = globalThis.setTimeout(() => {
    retryTimer = null
    void startWebMcpInitialization().catch((error) => {
      console.warn(
        '[MissionGraph] WebMCP registration failed; waiting to retry.',
        registrationErrorMessage(error),
      )
    })
  }, delay)
}

async function bootstrapWebMcp(
  runtime: WebMcpRuntime,
): Promise<RegistryStatus> {
  const probe = wrapTool(helloMissionGraph)
  const dynamicToolsTier = await detectDynamicRegistrationTier(
    runtime.modelContext,
    probe,
  )
  const registeredTools = await runtime.modelContext.getTools()

  const coreTools = coreDefinitions.map(wrapTool)
  const nextCoreControllers: AbortController[] = []
  let nextDynamicController: DynamicToolController<ModelContextTool> | null = null
  let nextUnsubscribeContext: (() => void) | null = null
  try {
    if (dynamicToolsTier !== 'provide-context') {
      const existing = new Set(registeredTools.map((tool) => tool.name))
      const initialTools =
        dynamicToolsTier === 'none'
          ? [...coreTools, ...contextualDefinitions.map(wrapTool)]
          : coreTools
      for (const tool of initialTools) {
        if (!existing.has(tool.name)) {
          if (dynamicToolsTier === 'abort-controller') {
            const controller = new AbortController()
            nextCoreControllers.push(controller)
            await runtime.modelContext.registerTool(tool, {
              signal: controller.signal,
            })
          } else {
            await runtime.modelContext.registerTool(tool)
          }
        }
        existing.add(tool.name)
      }
    }

    nextDynamicController = new DynamicToolController(
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
    const contextualTools = [
      ...new Map(
        currentContextualDefinitions().map((definition) => [
          definition.name,
          definition,
        ]),
      ).values(),
    ]
    await nextDynamicController.update(
      contextualTools.map(wrapTool),
      true,
    )
    nextUnsubscribeContext = useMissionStore.subscribe((state, previous) => {
      if (
        state.selectedId !== previous.selectedId ||
        state.nodes !== previous.nodes ||
        state.edges !== previous.edges
      ) {
        void refreshContextualTools(state.selectedId !== previous.selectedId)
      }
    })

    coreControllers = nextCoreControllers
    dynamicController = nextDynamicController
    unsubscribeContext = nextUnsubscribeContext
    if (dynamicToolsTier === 'provide-context') {
      clearProvidedContext = async () => {
        await runtime.modelContext.provideContext?.({ tools: [] })
      }
    }
  } catch (error) {
    nextUnsubscribeContext?.()
    nextDynamicController?.dispose()
    nextCoreControllers.forEach((controller) => controller.abort())
    if (dynamicToolsTier === 'provide-context') {
      await runtime.modelContext.provideContext?.({ tools: [] })
    }
    throw error
  }

  console.info(
    `[MissionGraph] WebMCP namespace=${runtime.namespace}; dynamic-tools tier=${dynamicToolsTier}`,
  )
  return { namespace: runtime.namespace, dynamicToolsTier }
}

async function initializeWebMcpRuntime(): Promise<RegistryRuntimeStatus> {
  const runtime = getWebMcpRuntime()
  if (!runtime) {
    setRegistryStatus({ state: 'waiting' })
    scheduleWebMcpRetry()
    return registryStatus
  }

  try {
    const status = await bootstrapWebMcp(runtime)
    retryDelayIndex = 0
    clearRetryTimer()
    const activeStatus: RegistryRuntimeStatus = { state: 'active', ...status }
    setRegistryStatus(activeStatus)
    return activeStatus
  } catch (error) {
    setRegistryStatus({
      state: 'waiting',
      error: registrationErrorMessage(error),
    })
    scheduleWebMcpRetry()
    throw error
  }
}

function startWebMcpInitialization() {
  if (registryStatus.state === 'active') return Promise.resolve(registryStatus)
  initialization ??= initializeWebMcpRuntime().finally(() => {
    initialization = undefined
  })
  return initialization
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
  return startWebMcpInitialization()
}

export function getWebMcpRegistryStatus() {
  return registryStatus
}

export function subscribeWebMcpRegistry(listener: () => void) {
  registryStatusListeners.add(listener)
  return () => registryStatusListeners.delete(listener)
}

export function recheckWebMcp() {
  if (registryStatus.state === 'active') return Promise.resolve(registryStatus)
  clearRetryTimer()
  retryDelayIndex = 0
  setRegistryStatus({ state: 'waiting' })
  return startWebMcpInitialization()
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
  clearRetryTimer()
  unsubscribeContext?.()
  unsubscribeContext = null
  dynamicController?.dispose()
  dynamicController = null
  coreControllers.forEach((controller) => controller.abort())
  coreControllers = []
  if (clearProvidedContext) {
    void clearProvidedContext().catch((error) => {
      console.warn(
        '[MissionGraph] failed to clear provided WebMCP context.',
        registrationErrorMessage(error),
      )
    })
  }
  clearProvidedContext = null
  initialization = undefined
  retryDelayIndex = 0
  setRegistryStatus({ state: 'waiting' })
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
