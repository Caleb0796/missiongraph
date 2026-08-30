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
  bootstrapRetryDelay,
  connectionProvedStable,
  configuredServer,
  estimateClockSkew,
  identityFailureDisposition,
  parseStoredIdentity,
  reconnectDelay,
  realtimeTransport,
  sequenceDisposition,
  type ClientIdentity,
  type IdentitySource,
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

interface SnapshotReceipt extends SnapshotResponse {
  serverTimestamp: string | null
  receivedAt: number
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

interface ActiveIdentity {
  client: ClientIdentity
  source: IdentitySource
  epoch: number
  clockCalibrated: boolean
}

interface StreamStamp {
  project: string
  epoch: number
  transport: 'websocket' | 'sse'
  openedAt: number
}

export class TransportError extends Error {
  code: string
  status?: number

  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'TransportError'
    this.code = code
    this.status = status
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
let identity: ActiveIdentity | null = null
let identityEpoch = 0
let socket: WebSocket | null = null
let eventSource: EventSource | null = null
let reconnectTimer: number | null = null
let stableTimer: number | null = null
let digestTimer: number | null = null
let bootstrapRetryTimer: number | null = null
let failedWebSockets = 0
let reconnectAttempt = 0
let bootstrapAttempt = 0
let identityRecovery: Promise<void> | null = null
let mutationQueue = Promise.resolve()
let initialization: Promise<void> | null = null
const historyClosers = new Set<() => void>()

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
    throw new TransportError(code, message, response.status)
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
  const resolved = client && 'client' in client ? client.client : client
  if (!resolved) {
    throw new TransportError('not_connected', 'No live project is connected.')
  }
  const response = await fetch(
    endpoint(`/api/p/${encodeURIComponent(resolved.project)}/snapshot`),
    { headers: { 'x-mg-token': resolved.token } },
  )
  const receivedAt = Date.now()
  return {
    ...(await jsonResponse<SnapshotResponse>(response)),
    serverTimestamp: response.headers.get('date'),
    receivedAt,
  } satisfies SnapshotReceipt
}

function activateIdentity(client: ClientIdentity, source: IdentitySource) {
  identityEpoch++
  useMissionStore.getState().setClockSkew(0)
  identity = {
    client,
    source,
    epoch: identityEpoch,
    clockCalibrated: false,
  }
  return identity
}

function identityIsActive(candidate: ActiveIdentity) {
  return (
    identity?.epoch === candidate.epoch &&
    identity.client.project === candidate.client.project
  )
}

function streamIsActive(stamp: StreamStamp) {
  return identity?.epoch === stamp.epoch && identity.client.project === stamp.project
}

function deactivateIdentity(candidate?: ActiveIdentity) {
  if (candidate && !identityIsActive(candidate)) return
  identityEpoch++
  identity = null
}

function calibrateClock(
  candidate: ActiveIdentity,
  serverTimestamp: string | null,
  receivedAt: number,
) {
  if (!identityIsActive(candidate) || candidate.clockCalibrated) return
  if (!serverTimestamp || Number.isNaN(Date.parse(serverTimestamp))) return
  candidate.clockCalibrated = true
  useMissionStore
    .getState()
    .setClockSkew(estimateClockSkew(serverTimestamp, receivedAt))
}

async function refreshSnapshot(candidate = identity) {
  if (!candidate) return
  const snapshot = await getSnapshot(candidate)
  if (!identityIsActive(candidate)) return
  calibrateClock(candidate, snapshot.serverTimestamp, snapshot.receivedAt)
  useMissionStore
    .getState()
    .applySnapshot(snapshot.state, snapshot.cursor, candidate.client.project)
}

function clearStableTimer() {
  if (stableTimer !== null) {
    window.clearTimeout(stableTimer)
    stableTimer = null
  }
}

function closeRealtime() {
  const activeSocket = socket
  const activeSource = eventSource
  socket = null
  eventSource = null
  clearStableTimer()
  activeSocket?.close()
  activeSource?.close()
}

function closeAllStreams() {
  closeRealtime()
  for (const close of [...historyClosers]) close()
  historyClosers.clear()
  if (digestTimer !== null) {
    window.clearTimeout(digestTimer)
    digestTimer = null
  }
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function clearBootstrapRetryTimer() {
  if (bootstrapRetryTimer !== null) {
    window.clearTimeout(bootstrapRetryTimer)
    bootstrapRetryTimer = null
  }
}

async function fetchServerDigest(candidate: ActiveIdentity) {
  if (!identityIsActive(candidate)) return
  const state = useMissionStore.getState()
  const cursor = Number(state.cursor)
  if (cursor === 0) return
  const response = await fetch(
    endpoint(
      `/api/p/${encodeURIComponent(candidate.client.project)}/mutations`,
    ),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mg-token': candidate.client.token,
        'x-mg-session': state.sessionId,
        'x-mg-actor': 'browser_agent',
      },
      body: JSON.stringify({
        type: 'SELECTION_CHANGED',
        payload: { client_id: state.sessionId, selected: [] },
        idem_key: crypto.randomUUID(),
        base_seq: cursor - 1,
      }),
    },
  )
  const receivedAt = Date.now()
  calibrateClock(candidate, response.headers.get('date'), receivedAt)
  if (response.status === 409) {
    const stale = (await response.json()) as StaleBody
    if (identityIsActive(candidate)) {
      useMissionStore
        .getState()
        .applyServerDigest(candidate.client.project, stale.fresh_digest)
    }
    return
  }
  if (!response.ok) await jsonResponse(response)
  throw new TransportError(
    'digest_probe_applied',
    'The authoritative digest probe unexpectedly appended a mutation.',
  )
}

function scheduleServerDigest(candidate: ActiveIdentity) {
  if (!identityIsActive(candidate) || digestTimer !== null) return
  digestTimer = window.setTimeout(() => {
    digestTimer = null
    void fetchServerDigest(candidate).catch((error: unknown) => {
      if (
        error instanceof TransportError &&
        identityFailureDisposition(candidate.source, error.status) !== 'retry'
      ) {
        void recoverExpiredIdentity(candidate, error.status).catch(
          enterFixtureWithRetry,
        )
      }
    })
  }, 80)
}

async function recoverExpiredIdentity(
  candidate: ActiveIdentity,
  status: number | undefined,
) {
  const disposition = identityFailureDisposition(candidate.source, status)
  if (disposition === 'invalid-link') {
    closeAllStreams()
    clearReconnectTimer()
    deactivateIdentity(candidate)
    useMissionStore
      .getState()
      .showInvalidMissionLink(storedIdentity() !== null)
    return
  }
  if (identityRecovery) return identityRecovery
  identityRecovery = (async () => {
    closeAllStreams()
    clearReconnectTimer()
    deactivateIdentity(candidate)
    localStorage.removeItem(IDENTITY_KEY)
    useMissionStore
      .getState()
      .setConnectionMode('loading', 'Starting a fresh mission copy…')
    const cloned = await cloneDemo()
    const client = { project: cloned.project, token: cloned.token }
    await connectProject(client, 'stored')
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
  const candidate = identity
  if (!candidate) return
  try {
    const snapshot = await getSnapshot(candidate)
    if (!identityIsActive(candidate)) return
    calibrateClock(candidate, snapshot.serverTimestamp, snapshot.receivedAt)
    useMissionStore
      .getState()
      .applySnapshot(
        snapshot.state,
        snapshot.cursor,
        candidate.client.project,
      )
    await fetchServerDigest(candidate)
    openRealtime(candidate)
  } catch (error) {
    if (
      error instanceof TransportError &&
      identityFailureDisposition(candidate.source, error.status) !== 'retry'
    ) {
      try {
        await recoverExpiredIdentity(candidate, error.status)
      } catch (recoveryError) {
        enterFixtureWithRetry(recoveryError)
      }
      return
    }
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (!identity || reconnectTimer !== null) return
  closeRealtime()
  const delay = reconnectDelay(reconnectAttempt++)
  useMissionStore
    .getState()
    .setConnectionMode(
      'loading',
      realtimeTransport(failedWebSockets) === 'sse'
        ? 'Live server · SSE reconnecting'
        : 'Live server · reconnecting',
    )
  reconnectTimer = window.setTimeout(() => void reconnect(), delay)
}

function proveConnectionStable(stamp: StreamStamp, receivedLiveEvent: boolean) {
  if (
    !streamIsActive(stamp) ||
    !connectionProvedStable(stamp.openedAt, Date.now(), receivedLiveEvent)
  ) {
    return
  }
  failedWebSockets = 0
  reconnectAttempt = 0
  clearStableTimer()
}

function beginStabilityWindow(stamp: StreamStamp) {
  clearStableTimer()
  stableTimer = window.setTimeout(
    () => proveConnectionStable(stamp, false),
    30_000,
  )
}

function handleRealtimeMessage(raw: string, stamp: StreamStamp) {
  if (!streamIsActive(stamp)) return
  const data = JSON.parse(raw) as
    | { kind: 'event'; event: MissionEvent }
    | { kind: 'snapshot'; state: GraphSnapshotState; cursor: string }
  if (data.kind === 'event') {
    if (data.event.project_id !== stamp.project) return
    const store = useMissionStore.getState()
    const disposition = sequenceDisposition(store.cursor, data.event.seq)
    if (disposition === 'duplicate') return
    if (disposition === 'gap') {
      if (stamp.transport === 'websocket') failedWebSockets++
      scheduleReconnect()
      return
    }
    calibrateClock(identity!, data.event.ts, Date.now())
    store.applyEvent(data.event)
    proveConnectionStable(stamp, true)
    scheduleServerDigest(identity!)
  } else {
    useMissionStore
      .getState()
      .applySnapshot(data.state, data.cursor, stamp.project)
    scheduleServerDigest(identity!)
  }
}

function openEventSource(candidate: ActiveIdentity) {
  closeRealtime()
  const cursor = useMissionStore.getState().cursor
  const stamp: StreamStamp = {
    project: candidate.client.project,
    epoch: candidate.epoch,
    transport: 'sse',
    openedAt: Date.now(),
  }
  const activeSource = new EventSource(
    realtimeEndpoint('sse', candidate.client, cursor),
  )
  eventSource = activeSource
  activeSource.addEventListener('message', (message) => {
    if (eventSource !== activeSource || !streamIsActive(stamp)) return
    handleRealtimeMessage(String(message.data), stamp)
  })
  activeSource.addEventListener('open', () => {
    if (eventSource !== activeSource || !streamIsActive(stamp)) return
    beginStabilityWindow(stamp)
    useMissionStore.getState().setConnectionMode('live', 'Live server · SSE fallback')
  })
  activeSource.addEventListener('error', () => {
    if (eventSource !== activeSource || !streamIsActive(stamp)) return
    scheduleReconnect()
  })
}

function openSocket(candidate: ActiveIdentity) {
  closeRealtime()
  const cursor = useMissionStore.getState().cursor
  const stamp: StreamStamp = {
    project: candidate.client.project,
    epoch: candidate.epoch,
    transport: 'websocket',
    openedAt: Date.now(),
  }
  const activeSocket = new WebSocket(
    realtimeEndpoint('websocket', candidate.client, cursor),
  )
  socket = activeSocket
  activeSocket.addEventListener('message', (message) => {
    if (socket !== activeSocket || !streamIsActive(stamp)) return
    handleRealtimeMessage(String(message.data), stamp)
  })
  activeSocket.addEventListener('open', () => {
    if (socket !== activeSocket || !streamIsActive(stamp)) return
    beginStabilityWindow(stamp)
    useMissionStore.getState().setConnectionMode('live', 'Live server')
  })
  activeSocket.addEventListener('close', () => {
    if (socket !== activeSocket || !streamIsActive(stamp)) return
    socket = null
    failedWebSockets++
    scheduleReconnect()
  })
}

function openRealtime(candidate = identity) {
  if (!candidate || !identityIsActive(candidate)) return
  clearReconnectTimer()
  if (realtimeTransport(failedWebSockets) === 'sse') {
    openEventSource(candidate)
  } else {
    openSocket(candidate)
  }
}

async function waitForSequence(seq: number, candidate: ActiveIdentity) {
  const deadline = Date.now() + 1_500
  while (
    identityIsActive(candidate) &&
    Number(useMissionStore.getState().cursor) < seq &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  }
  if (
    identityIsActive(candidate) &&
    Number(useMissionStore.getState().cursor) < seq
  ) {
    await refreshSnapshot(candidate)
  }
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
  const candidate = identity
  if (!candidate) {
    throw new TransportError('not_connected', 'No live project is connected.')
  }

  const response = await fetch(
    endpoint(
      `/api/p/${encodeURIComponent(candidate.client.project)}/mutations`,
    ),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mg-token': candidate.client.token,
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
    useMissionStore
      .getState()
      .applyServerDigest(candidate.client.project, stale.fresh_digest)
    await refreshSnapshot(candidate)
    const error = new TransportError(
      'stale_mutation',
      'The graph changed concurrently; the live snapshot was refreshed.',
    )
    useMissionStore.getState().showToast(error.message, 'error')
    throw error
  }
  const result = await jsonResponse<MutationResponse>(response)
  await waitForSequence(result.seq, candidate)
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
  const candidate = identity
  if (!candidate) {
    throw new TransportError('not_connected', 'No live project is connected.')
  }
  const response = await fetch(
    endpoint(
      `/api/p/${encodeURIComponent(candidate.client.project)}/mutations`,
    ),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mg-token': candidate.client.token,
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
    useMissionStore
      .getState()
      .applyServerDigest(candidate.client.project, stale.fresh_digest)
    await refreshSnapshot(candidate)
    const error = new TransportError(
      'stale_mutation',
      'The graph changed concurrently; the live snapshot was refreshed.',
    )
    useMissionStore.getState().showToast(error.message, 'error')
    throw error
  }
  const result = await jsonResponse<BatchMutationResponse>(response)
  if (result.seqs.length > 0) {
    await waitForSequence(result.seqs.at(-1)!, candidate)
    await loadChangesSince(state.cursor, candidate)
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

function enterFixtureWithRetry(error: unknown) {
  closeAllStreams()
  clearReconnectTimer()
  deactivateIdentity()
  const delay = bootstrapRetryDelay(bootstrapAttempt++)
  const message =
    error instanceof Error ? error.message : 'The live server is unreachable.'
  useMissionStore
    .getState()
    .useFixture(
      `Offline fixture · ${message} · retrying in ${Math.round(delay / 1_000)}s`,
    )
  clearBootstrapRetryTimer()
  bootstrapRetryTimer = window.setTimeout(() => {
    bootstrapRetryTimer = null
    void initializeMissionClient()
  }, delay)
}

function markBootstrapConnected() {
  bootstrapAttempt = 0
  clearBootstrapRetryTimer()
}

async function bootstrap() {
  const store = useMissionStore.getState()
  store.setSessionId(sessionId())
  configureMutationSender(mutate)
  try {
    const linked = sharedIdentityFromUrl()
    if (linked) {
      try {
        await connectProject(linked, 'url')
        markBootstrapConnected()
        return
      } catch (error) {
        if (
          error instanceof TransportError &&
          identityFailureDisposition('url', error.status) === 'invalid-link'
        ) {
          closeAllStreams()
          clearReconnectTimer()
          deactivateIdentity()
          store.showInvalidMissionLink(storedIdentity() !== null)
          return
        }
        throw error
      }
    }

    const persisted = storedIdentity()
    let expired = false
    if (persisted) {
      try {
        await connectProject(persisted, 'stored')
        markBootstrapConnected()
        return
      } catch (error) {
        if (
          !(error instanceof TransportError) ||
          identityFailureDisposition('stored', error.status) !== 'replace-stored'
        ) {
          throw error
        }
        closeAllStreams()
        clearReconnectTimer()
        deactivateIdentity()
        localStorage.removeItem(IDENTITY_KEY)
        expired = true
      }
    }
    const cloned = await cloneDemo()
    const client = { project: cloned.project, token: cloned.token }
    await connectProject(client, 'stored')
    persistIdentity(client)
    markBootstrapConnected()
    if (expired) {
      store.showToast('previous session expired — started a fresh mission copy')
    }
  } catch (error) {
    enterFixtureWithRetry(error)
  }
}

async function connectProject(client: ClientIdentity, source: IdentitySource) {
  closeAllStreams()
  clearReconnectTimer()
  const candidate = activateIdentity(client, source)
  const snapshot = await getSnapshot(candidate)
  if (!identityIsActive(candidate)) return candidate
  calibrateClock(candidate, snapshot.serverTimestamp, snapshot.receivedAt)
  const store = useMissionStore.getState()
  store.applySnapshot(snapshot.state, snapshot.cursor, client.project)
  await fetchServerDigest(candidate)
  await loadChangesSince('0', candidate)
  openRealtime(candidate)
  return candidate
}

export function initializeMissionClient() {
  initialization ??= bootstrap().finally(() => {
    initialization = null
  })
  return initialization
}

async function startFreshMission(message: string, announce: boolean) {
  clearBootstrapRetryTimer()
  clearSharedIdentityFromUrl()
  localStorage.removeItem(IDENTITY_KEY)
  closeAllStreams()
  clearReconnectTimer()
  deactivateIdentity()
  failedWebSockets = 0
  reconnectAttempt = 0
  useMissionStore
    .getState()
    .setConnectionMode('loading', message)
  try {
    const cloned = await cloneDemo()
    const client = { project: cloned.project, token: cloned.token }
    await connectProject(client, 'stored')
    persistIdentity(client)
    markBootstrapConnected()
    if (announce) {
      useMissionStore
        .getState()
        .showToast('started a fresh mission copy')
    }
  } catch (error) {
    enterFixtureWithRetry(error)
  }
}

export function resetMissionDemo() {
  return startFreshMission('Resetting to a fresh visitor project…', false)
}

export function startFreshMissionCopy() {
  return startFreshMission('Starting a fresh mission copy…', true)
}

export async function openStoredMission() {
  const persisted = storedIdentity()
  if (!persisted) {
    throw new TransportError('not_connected', 'No stored mission is available.')
  }
  clearBootstrapRetryTimer()
  clearSharedIdentityFromUrl()
  closeAllStreams()
  clearReconnectTimer()
  deactivateIdentity()
  useMissionStore
    .getState()
    .setConnectionMode('loading', 'Opening your stored mission…')
  try {
    await connectProject(persisted, 'stored')
    markBootstrapConnected()
  } catch (error) {
    if (
      error instanceof TransportError &&
      identityFailureDisposition('stored', error.status) === 'replace-stored'
    ) {
      localStorage.removeItem(IDENTITY_KEY)
      await startFreshMission(
        'Your stored mission expired — starting a fresh copy…',
        true,
      )
      return
    }
    enterFixtureWithRetry(error)
  }
}

export function reconnectMission() {
  clearBootstrapRetryTimer()
  bootstrapAttempt = 0
  useMissionStore
    .getState()
    .setConnectionMode('loading', 'Reconnecting to the live server…')
  return initializeMissionClient()
}

async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Try the synchronous browser fallback below.
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } finally {
    textarea.remove()
  }
  return copied
}

export async function copyCurrentMissionLink() {
  const candidate = identity
  const state = useMissionStore.getState()
  if (
    !candidate ||
    state.connectionMode !== 'live' ||
    state.projectId !== candidate.client.project
  ) {
    throw new TransportError('not_connected', 'No live project is connected.')
  }
  const url = new URL('/', window.location.href)
  url.searchParams.set('mg_project', candidate.client.project)
  url.searchParams.set('mg_token', candidate.client.token)
  const value = url.toString()
  return { url: value, copied: await copyText(value) }
}

function loadHistoryWithWebSocket(
  candidate: ActiveIdentity,
  since: string,
  target: number,
) {
  return new Promise<void>((resolve, reject) => {
    const historySocket = new WebSocket(
      realtimeEndpoint('websocket', candidate.client, since),
    )
    let settled = false
    const finish = (error?: TransportError) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      historyClosers.delete(cancel)
      historySocket.close()
      if (error) reject(error)
      else resolve()
    }
    const cancel = () =>
      finish(
        new TransportError(
          'history_cancelled',
          'Graph history changed identity while loading.',
        ),
      )
    historyClosers.add(cancel)
    const timeout = window.setTimeout(
      () =>
        finish(
          new TransportError('history_timeout', 'Timed out loading graph history.'),
        ),
      3_000,
    )
    historySocket.addEventListener('message', (message) => {
      if (!identityIsActive(candidate)) {
        cancel()
        return
      }
      const data = JSON.parse(String(message.data)) as
        | { kind: 'event'; event: MissionEvent }
        | { kind: 'snapshot' }
      if (
        data.kind !== 'event' ||
        data.event.project_id !== candidate.client.project
      ) {
        return
      }
      useMissionStore.getState().recordHistoricalEvent(data.event)
      if (data.event.seq >= target) finish()
    })
    historySocket.addEventListener('error', () =>
      finish(
        new TransportError('history_unavailable', 'Graph history is unavailable.'),
      ),
    )
  })
}

function loadHistoryWithSse(
  candidate: ActiveIdentity,
  since: string,
  target: number,
) {
  return new Promise<void>((resolve, reject) => {
    const historySource = new EventSource(
      realtimeEndpoint('sse', candidate.client, since),
    )
    let settled = false
    const finish = (error?: TransportError) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      historyClosers.delete(cancel)
      historySource.close()
      if (error) reject(error)
      else resolve()
    }
    const cancel = () =>
      finish(
        new TransportError(
          'history_cancelled',
          'Graph history changed identity while loading.',
        ),
      )
    historyClosers.add(cancel)
    const timeout = window.setTimeout(
      () =>
        finish(
          new TransportError('history_timeout', 'Timed out loading graph history.'),
        ),
      3_000,
    )
    historySource.addEventListener('message', (message) => {
      if (!identityIsActive(candidate)) {
        cancel()
        return
      }
      const data = JSON.parse(String(message.data)) as
        | { kind: 'event'; event: MissionEvent }
        | { kind: 'snapshot' }
      if (
        data.kind !== 'event' ||
        data.event.project_id !== candidate.client.project
      ) {
        return
      }
      useMissionStore.getState().recordHistoricalEvent(data.event)
      if (data.event.seq >= target) finish()
    })
    historySource.addEventListener('error', () =>
      finish(
        new TransportError('history_unavailable', 'Graph history is unavailable.'),
      ),
    )
  })
}

export async function loadChangesSince(
  since: string,
  candidate = identity,
) {
  const state = useMissionStore.getState()
  if (state.connectionMode === 'fixture') {
    for (const event of state.events.filter((event) => event.seq > Number(since))) {
      state.recordHistoricalEvent(event)
    }
    return
  }
  if (
    !candidate ||
    !identityIsActive(candidate) ||
    Number(since) >= Number(state.cursor)
  ) {
    return
  }

  const target = Number(state.cursor)
  try {
    await loadHistoryWithWebSocket(candidate, since, target)
  } catch {
    if (!identityIsActive(candidate)) return
    await loadHistoryWithSse(candidate, since, target)
  }
}
