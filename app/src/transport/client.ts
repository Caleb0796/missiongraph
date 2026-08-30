import type {
  Actor,
  DigestChange,
  EventPayloadMap,
  EvType,
  GraphDigest,
  GraphSnapshotState,
  MissionEvent,
} from '../model/types'
import {
  configureMutationSender,
  type MutationOptions,
  useMissionStore,
} from '../store/mission-store'
import {
  configuredServer,
  parseStoredIdentity,
  reconnectDelay,
  realtimeTransport,
  sequenceDisposition,
  shouldReplaceStoredIdentity,
  type ClientIdentity,
} from './client-logic'

const SESSION_KEY = 'missiongraph.session-id'
const IDENTITY_KEY = 'missiongraph.visitor-identity'

interface CloneResponse extends ClientIdentity {
  cursor: string
}

interface SnapshotResponse {
  state: GraphSnapshotState
  cursor: string
}

interface MutationResponse {
  seq: number
}

interface BatchMutationResponse {
  seqs: number[]
}

interface ErrorBody {
  error?: { code?: string; message?: string } | string
}

interface StaleBody {
  fresh_digest: GraphDigest
}

export class TransportError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'TransportError'
    this.code = code
  }
}

const serverConfiguration = (() => {
  try {
    return {
      ...configuredServer(import.meta.env.VITE_MG_SERVER, import.meta.env.DEV),
      error: null,
    }
  } catch (error) {
    return {
      logicalServer: null,
      requestBase: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
})()
const debounceTimers = new Map<
  string,
  { timer: number; resolve: (cursor: number) => void }
>()
let identity: ClientIdentity | null = null
let socket: WebSocket | null = null
let eventSource: EventSource | null = null
let reconnectTimer: number | null = null
let failedWebSockets = 0
let reconnectAttempt = 0
let identityRecovery: Promise<void> | null = null
let mutationQueue = Promise.resolve()
let initialization: Promise<void> | null = null

export type MutationBatchItem = {
  [T in EvType]: { type: T; payload: EventPayloadMap[T] }
}[EvType]

function sessionId() {
  const existing = sessionStorage.getItem(SESSION_KEY)
  if (existing) return existing
  const created = crypto.randomUUID()
  sessionStorage.setItem(SESSION_KEY, created)
  return created
}

function endpoint(path: string) {
  if (!serverConfiguration.requestBase) {
    throw new TransportError(
      'server_not_configured',
      serverConfiguration.error ??
        'VITE_MG_SERVER must provide the absolute production API URL.',
    )
  }
  return `${serverConfiguration.requestBase}${path}`
}

function realtimeEndpoint(
  protocol: 'websocket' | 'sse',
  client: ClientIdentity,
  cursor: string,
) {
  const query = new URLSearchParams({
    project: client.project,
    from_seq: cursor,
    token: client.token,
  })
  if (import.meta.env.DEV) {
    if (protocol === 'sse') return `/mg/sse?${query}`
    const websocketProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${websocketProtocol}//${window.location.host}/mg/ws?${query}`
  }
  if (!serverConfiguration.logicalServer) endpoint('')
  const url = new URL(serverConfiguration.logicalServer!)
  if (protocol === 'websocket') {
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  }
  url.pathname = protocol === 'websocket' ? '/ws' : '/sse'
  url.search = query.toString()
  return url.toString()
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as ErrorBody
  if (!response.ok) {
    const error = body.error
    const message =
      typeof error === 'string'
        ? error
        : error?.message ?? `${response.status} ${response.statusText}`
    const code =
      typeof error === 'object' && error?.code
        ? error.code
        : `http_${response.status}`
    throw new TransportError(code, message)
  }
  return body as T
}

async function cloneDemo() {
  return jsonResponse<CloneResponse>(
    await fetch(endpoint('/api/clone-demo'), { method: 'POST' }),
  )
}

function storedIdentity() {
  const stored = parseStoredIdentity(localStorage.getItem(IDENTITY_KEY))
  if (!stored) localStorage.removeItem(IDENTITY_KEY)
  return stored
}

function persistIdentity(client: ClientIdentity) {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(client))
}

async function getSnapshot(client = identity) {
  if (!client) throw new TransportError('not_connected', 'No live project is connected.')
  return jsonResponse<SnapshotResponse>(
    await fetch(endpoint(`/api/p/${encodeURIComponent(client.project)}/snapshot`), {
      headers: { 'x-mg-token': client.token },
    }),
  )
}

async function refreshSnapshot() {
  if (!identity) return
  const snapshot = await getSnapshot(identity)
  useMissionStore
    .getState()
    .applySnapshot(snapshot.state, snapshot.cursor, identity.project)
}

function closeRealtime() {
  const activeSocket = socket
  const activeSource = eventSource
  socket = null
  eventSource = null
  activeSocket?.close()
  activeSource?.close()
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

async function recoverExpiredIdentity() {
  if (identityRecovery) return identityRecovery
  identityRecovery = (async () => {
    closeRealtime()
    clearReconnectTimer()
    localStorage.removeItem(IDENTITY_KEY)
    clearSharedIdentityFromUrl()
    useMissionStore
      .getState()
      .setConnectionMode('loading', 'Starting a fresh mission copy…')
    const cloned = await cloneDemo()
    const client = { project: cloned.project, token: cloned.token }
    await connectProject(client)
    persistIdentity(client)
    useMissionStore
      .getState()
      .showToast('previous session expired — started a fresh mission copy')
  })().finally(() => {
    identityRecovery = null
  })
  return identityRecovery
}

async function reconnect() {
  reconnectTimer = null
  const client = identity
  if (!client) return
  try {
    await getSnapshot(client)
    openRealtime()
  } catch (error) {
    if (error instanceof TransportError && shouldReplaceStoredIdentity(error.code)) {
      try {
        await recoverExpiredIdentity()
      } catch {
        scheduleReconnect()
      }
      return
    }
    scheduleReconnect()
  }
}

function scheduleReconnect(immediate = false) {
  if (!identity || reconnectTimer !== null) return
  closeRealtime()
  const delay = immediate ? 0 : reconnectDelay(reconnectAttempt++)
  useMissionStore
    .getState()
    .setConnectionMode(
      'live',
      realtimeTransport(failedWebSockets) === 'sse'
        ? 'Live server · SSE reconnecting'
        : 'Live server · reconnecting',
    )
  reconnectTimer = window.setTimeout(() => void reconnect(), delay)
}

function handleRealtimeMessage(raw: string) {
  const data = JSON.parse(raw) as
    | { kind: 'event'; event: MissionEvent }
    | { kind: 'snapshot'; state: GraphSnapshotState; cursor: string }
  if (data.kind === 'event') {
    const store = useMissionStore.getState()
    const disposition = sequenceDisposition(store.cursor, data.event.seq)
    if (disposition === 'duplicate') return
    if (disposition === 'gap') {
      scheduleReconnect(true)
      return
    }
    store.applyEvent(data.event)
    reconnectAttempt = 0
  } else if (identity) {
    useMissionStore
      .getState()
      .applySnapshot(data.state, data.cursor, identity.project)
  }
}

function openEventSource(client: ClientIdentity) {
  closeRealtime()
  const cursor = useMissionStore.getState().cursor
  const activeSource = new EventSource(realtimeEndpoint('sse', client, cursor))
  eventSource = activeSource
  activeSource.addEventListener('message', (message) => {
    if (eventSource !== activeSource) return
    handleRealtimeMessage(String(message.data))
  })
  activeSource.addEventListener('open', () => {
    if (eventSource !== activeSource) return
    useMissionStore.getState().setConnectionMode('live', 'Live server · SSE fallback')
  })
  activeSource.addEventListener('error', () => {
    if (eventSource !== activeSource) return
    scheduleReconnect()
  })
}

function openSocket(client: ClientIdentity) {
  closeRealtime()
  const cursor = useMissionStore.getState().cursor
  const activeSocket = new WebSocket(
    realtimeEndpoint('websocket', client, cursor),
  )
  socket = activeSocket
  activeSocket.addEventListener('message', (message) => {
    if (socket !== activeSocket) return
    failedWebSockets = 0
    handleRealtimeMessage(String(message.data))
  })
  activeSocket.addEventListener('open', () => {
    if (socket !== activeSocket) return
    useMissionStore.getState().setConnectionMode('live', 'Live server')
  })
  activeSocket.addEventListener('close', () => {
    if (socket !== activeSocket) return
    socket = null
    failedWebSockets++
    scheduleReconnect()
  })
}

function openRealtime() {
  const client = identity
  if (!client) return
  clearReconnectTimer()
  if (realtimeTransport(failedWebSockets) === 'sse') {
    openEventSource(client)
  } else {
    openSocket(client)
  }
}

async function waitForSequence(seq: number) {
  const deadline = Date.now() + 1_500
  while (Number(useMissionStore.getState().cursor) < seq && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  }
  if (Number(useMissionStore.getState().cursor) < seq) await refreshSnapshot()
}

function fixtureMutation<T extends EvType>(
  type: T,
  payload: EventPayloadMap[T],
  actor: Actor,
) {
  if (
    actor === 'browser_agent' &&
    (type === 'APPROVED' || type === 'REJECTED') &&
    !('policy_ref' in payload && payload.policy_ref)
  ) {
    throw new TransportError(
      'invalid_event',
      `${type} by browser_agent requires policy_ref`,
    )
  }
  const state = useMissionStore.getState()
  const event = {
    seq: Number(state.cursor) + 1,
    project_id: state.projectId ?? 'shorty-demo',
    ts: new Date().toISOString(),
    actor,
    type,
    payload,
    idem_key: crypto.randomUUID(),
  } as MissionEvent
  state.applyEvent(event)
  return event.seq
}

async function postMutation<T extends EvType>(
  type: T,
  payload: EventPayloadMap[T],
  actor: 'human' | 'browser_agent',
): Promise<number> {
  const state = useMissionStore.getState()
  if (state.connectionMode === 'fixture') {
    return fixtureMutation(type, payload, actor)
  }
  if (!identity) throw new TransportError('not_connected', 'No live project is connected.')

  const response = await fetch(
    endpoint(`/api/p/${encodeURIComponent(identity.project)}/mutations`),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mg-token': identity.token,
        'x-mg-session': state.sessionId,
        'x-mg-actor': actor,
      },
      body: JSON.stringify({
        type,
        payload,
        idem_key: crypto.randomUUID(),
        base_seq: Number(state.cursor),
      }),
    },
  )
  if (response.status === 409) {
    const stale = (await response.json()) as StaleBody
    useMissionStore
      .getState()
      .applyDigestChanges(
        stale.fresh_digest.changes_since as DigestChange[],
        stale.fresh_digest.cursor,
      )
    await refreshSnapshot()
    const error = new TransportError(
      'stale_mutation',
      'The graph changed concurrently; the live snapshot was refreshed.',
    )
    useMissionStore.getState().showToast(error.message, 'error')
    throw error
  }
  const result = await jsonResponse<MutationResponse>(response)
  await waitForSequence(result.seq)
  return result.seq
}

async function postMutationBatch(
  batch: MutationBatchItem[],
  actor: 'human' | 'browser_agent',
): Promise<number[]> {
  const state = useMissionStore.getState()
  if (state.connectionMode === 'fixture') {
    return batch.map((item) => fixtureMutation(item.type, item.payload, actor))
  }
  if (!identity) throw new TransportError('not_connected', 'No live project is connected.')
  const response = await fetch(
    endpoint(`/api/p/${encodeURIComponent(identity.project)}/mutations`),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mg-token': identity.token,
        'x-mg-session': state.sessionId,
        'x-mg-actor': actor,
      },
      body: JSON.stringify({
        batch,
        idem_key: crypto.randomUUID(),
        base_seq: Number(state.cursor),
      }),
    },
  )
  if (response.status === 409) {
    const stale = (await response.json()) as StaleBody
    useMissionStore
      .getState()
      .applyDigestChanges(
        stale.fresh_digest.changes_since as DigestChange[],
        stale.fresh_digest.cursor,
      )
    await refreshSnapshot()
    const error = new TransportError(
      'stale_mutation',
      'The graph changed concurrently; the live snapshot was refreshed.',
    )
    useMissionStore.getState().showToast(error.message, 'error')
    throw error
  }
  const result = await jsonResponse<BatchMutationResponse>(response)
  if (result.seqs.length > 0) {
    await waitForSequence(result.seqs.at(-1)!)
    await loadChangesSince(state.cursor)
  }
  return result.seqs
}

export function mutate<T extends EvType>(
  type: T,
  payload: EventPayloadMap[T],
  options: MutationOptions = {},
): Promise<number> {
  const actor = options.actor ?? 'human'
  if (options.debounceKey) {
    const previous = debounceTimers.get(options.debounceKey)
    if (previous) {
      window.clearTimeout(previous.timer)
      previous.resolve(Number(useMissionStore.getState().cursor))
    }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        debounceTimers.delete(options.debounceKey!)
        mutate(type, payload, { actor }).then(resolve, reject)
      }, 260)
      debounceTimers.set(options.debounceKey!, { timer, resolve })
    })
  }

  const queued = mutationQueue.then(() => postMutation(type, payload, actor))
  mutationQueue = queued.then(
    () => undefined,
    () => undefined,
  )
  return queued
}

export function mutateBatch(
  batch: MutationBatchItem[],
  options: Pick<MutationOptions, 'actor'> = {},
): Promise<number[]> {
  const actor = options.actor ?? 'human'
  const queued = mutationQueue.then(() => postMutationBatch(batch, actor))
  mutationQueue = queued.then(
    () => undefined,
    () => undefined,
  )
  return queued
}

function sharedIdentityFromUrl(): ClientIdentity | null {
  const params = new URLSearchParams(window.location.search)
  const project = params.get('mg_project')
  const token = params.get('mg_token')
  return project && token ? { project, token } : null
}

function clearSharedIdentityFromUrl() {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('mg_project') && !url.searchParams.has('mg_token')) return
  url.searchParams.delete('mg_project')
  url.searchParams.delete('mg_token')
  window.history.replaceState(null, '', url)
}

async function bootstrap() {
  const store = useMissionStore.getState()
  store.setSessionId(sessionId())
  configureMutationSender(mutate)
  try {
    const candidate = sharedIdentityFromUrl() ?? storedIdentity()
    let expired = false
    if (candidate) {
      try {
        await connectProject(candidate)
        persistIdentity(candidate)
        return
      } catch (error) {
        if (!(error instanceof TransportError) || !shouldReplaceStoredIdentity(error.code)) {
          throw error
        }
        localStorage.removeItem(IDENTITY_KEY)
        clearSharedIdentityFromUrl()
        expired = true
      }
    }
    const cloned = await cloneDemo()
    const client = { project: cloned.project, token: cloned.token }
    await connectProject(client)
    persistIdentity(client)
    if (expired) {
      store.showToast('previous session expired — started a fresh mission copy')
    }
  } catch (error) {
    identity = null
    const message =
      error instanceof Error ? error.message : 'The live server is unreachable.'
    store.useFixture(`Offline fixture · ${message}`)
  }
}

async function connectProject(client: ClientIdentity) {
  const snapshot = await getSnapshot(client)
  identity = client
  const store = useMissionStore.getState()
  store.applySnapshot(snapshot.state, snapshot.cursor, client.project)
  await loadChangesSince('0')
  openRealtime()
}

export function initializeMissionClient() {
  initialization ??= bootstrap()
  return initialization
}

export async function resetMissionDemo() {
  localStorage.removeItem(IDENTITY_KEY)
  identity = null
  failedWebSockets = 0
  reconnectAttempt = 0
  closeRealtime()
  clearReconnectTimer()
  useMissionStore
    .getState()
    .setConnectionMode('loading', 'Resetting to a fresh visitor project…')
  try {
    const cloned = await cloneDemo()
    const client = { project: cloned.project, token: cloned.token }
    await connectProject(client)
    persistIdentity(client)
  } catch (error) {
    identity = null
    const message = error instanceof Error ? error.message : String(error)
    useMissionStore.getState().useFixture(`Offline fixture · ${message}`)
  }
}

export async function copyCurrentMissionLink() {
  if (!identity) {
    throw new TransportError('not_connected', 'No live project is connected.')
  }
  const url = new URL('/', window.location.href)
  url.searchParams.set('mg_project', identity.project)
  url.searchParams.set('mg_token', identity.token)
  await navigator.clipboard.writeText(url.toString())
  return url.toString()
}

function loadHistoryWithWebSocket(client: ClientIdentity, since: string, target: number) {
  return new Promise<void>((resolve, reject) => {
    const historySocket = new WebSocket(
      realtimeEndpoint('websocket', client, since),
    )
    const timeout = window.setTimeout(() => {
      historySocket.close()
      reject(new TransportError('history_timeout', 'Timed out loading graph history.'))
    }, 3_000)
    historySocket.addEventListener('message', (message) => {
      const data = JSON.parse(String(message.data)) as
        | { kind: 'event'; event: MissionEvent }
        | { kind: 'snapshot' }
      if (data.kind !== 'event') return
      useMissionStore.getState().recordHistoricalEvent(data.event)
      if (data.event.seq >= target) {
        window.clearTimeout(timeout)
        historySocket.close()
        resolve()
      }
    })
    historySocket.addEventListener('error', () => {
      window.clearTimeout(timeout)
      historySocket.close()
      reject(new TransportError('history_unavailable', 'Graph history is unavailable.'))
    })
  })
}

function loadHistoryWithSse(client: ClientIdentity, since: string, target: number) {
  return new Promise<void>((resolve, reject) => {
    const historySource = new EventSource(realtimeEndpoint('sse', client, since))
    const timeout = window.setTimeout(() => {
      historySource.close()
      reject(new TransportError('history_timeout', 'Timed out loading graph history.'))
    }, 3_000)
    historySource.addEventListener('message', (message) => {
      const data = JSON.parse(String(message.data)) as
        | { kind: 'event'; event: MissionEvent }
        | { kind: 'snapshot' }
      if (data.kind !== 'event') return
      useMissionStore.getState().recordHistoricalEvent(data.event)
      if (data.event.seq >= target) {
        window.clearTimeout(timeout)
        historySource.close()
        resolve()
      }
    })
    historySource.addEventListener('error', () => {
      window.clearTimeout(timeout)
      historySource.close()
      reject(new TransportError('history_unavailable', 'Graph history is unavailable.'))
    })
  })
}

export async function loadChangesSince(since: string) {
  const state = useMissionStore.getState()
  if (state.connectionMode === 'fixture') {
    for (const event of state.events.filter((event) => event.seq > Number(since))) {
      state.recordHistoricalEvent(event)
    }
    return
  }
  if (!identity || Number(since) >= Number(state.cursor)) return

  const target = Number(state.cursor)
  try {
    await loadHistoryWithWebSocket(identity, since, target)
  } catch {
    failedWebSockets++
    await loadHistoryWithSse(identity, since, target)
  }
}
