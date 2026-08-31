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
  clockSampleIsFresh,
  connectionProvedStable,
  configuredServer,
  copyText,
  digestRetryDelay,
  estimateClockSkew,
  identityFailureDisposition,
  mutationEpochMatches,
  parseStoredIdentity,
  reconnectDelay,
  realtimeTransport,
  sequenceDisposition,
  type ClientIdentity,
  type IdentitySource,
} from './client-logic'
import { SettledDebouncer } from './settled-debounce'

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
  bodyTimestamp: string | null
  headerTimestamp: string | null
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
  clockSampledAt: number | null
}

interface MutationContext {
  candidate: ActiveIdentity | null
  epoch: number
  projectId: string | null
  fixture: boolean
  cursor: string
  sessionId: string
  idemKey: string
  staleMode: 'error' | 'silent'
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
  notified: boolean

  constructor(
    code: string,
    message: string,
    status?: number,
    notified = false,
  ) {
    super(message)
    this.name = 'TransportError'
    this.code = code
    this.status = status
    this.notified = notified
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
const mutationDebouncer = new SettledDebouncer<number>({
  setTimeout: (callback, milliseconds) =>
    window.setTimeout(callback, milliseconds),
  clearTimeout: (timer) => window.clearTimeout(timer as number),
})
let identity: ActiveIdentity | null = null
let identityEpoch = 0
let socket: WebSocket | null = null
let eventSource: EventSource | null = null
let reconnectTimer: number | null = null
let stableTimer: number | null = null
let digestTimer: number | null = null
let digestRetryAttempt = 0
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

function latestSnapshotTimestamp(state: GraphSnapshotState) {
  const candidates = [
    ...Object.values(state.nodes).map((node) => node.ready_since),
    ...Object.values(state.tombstones).map((item) => item.removed_at),
    ...Object.values(state.approvals).flatMap((item) => [
      item.created_at,
      item.resolved_at,
    ]),
    ...Object.values(state.policies).map((item) => item.stated_at),
    ...Object.values(state.annotations).flatMap((items) =>
      items.map((item) => item.ts),
    ),
    ...state.journal.map((item) => item.ts),
    ...Object.values(state.deviations).flatMap((items) =>
      items.map((item) => item.ts),
    ),
  ].filter((value): value is string => Boolean(value))
  return candidates.reduce<string | null>((latest, value) => {
    const parsed = Date.parse(value)
    if (Number.isNaN(parsed)) return latest
    return latest === null || parsed > Date.parse(latest) ? value : latest
  }, null)
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
  const snapshot = await jsonResponse<SnapshotResponse>(response)
  return {
    ...snapshot,
    bodyTimestamp: latestSnapshotTimestamp(snapshot.state),
    headerTimestamp: response.headers.get('date'),
    receivedAt,
  } satisfies SnapshotReceipt
}

function activateIdentity(client: ClientIdentity, source: IdentitySource) {
  resetTransportPenalties()
  identityEpoch++
  useMissionStore.getState().setClockSkew(0)
  identity = {
    client,
    source,
    epoch: identityEpoch,
    clockSampledAt: null,
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
  bodyTimestamp: string | null,
  receivedAt: number,
  headerTimestamp: string | null = null,
  force = false,
) {
  if (
    !identityIsActive(candidate) ||
    (!force && clockSampleIsFresh(candidate.clockSampledAt, receivedAt))
  ) {
    return
  }
  const serverTimestamp = headerTimestamp ?? bodyTimestamp
  if (!serverTimestamp || Number.isNaN(Date.parse(serverTimestamp))) return
  candidate.clockSampledAt = receivedAt
  useMissionStore
    .getState()
    .setClockSkew(estimateClockSkew(serverTimestamp, receivedAt))
}

function captureMutationContext(
  staleMode: MutationOptions['staleMode'] = 'error',
): MutationContext {
  const state = useMissionStore.getState()
  const candidate = identity
  return {
    candidate,
    epoch: identityEpoch,
    projectId: candidate?.client.project ?? state.projectId,
    fixture: state.connectionMode === 'fixture',
    cursor: state.cursor,
    sessionId: state.sessionId,
    idemKey: crypto.randomUUID(),
    staleMode,
  }
}

function mutationContextIsActive(context: MutationContext) {
  const activeProject =
    identity?.client.project ?? useMissionStore.getState().projectId
  return mutationEpochMatches(
    context.epoch,
    context.projectId,
    identityEpoch,
    activeProject,
  )
}

function staleMutationError(
  context: MutationContext,
  operation: string,
  userVisible: boolean,
) {
  console.info(
    `[MissionGraph] Dropped ${operation} from expired identity epoch ${context.epoch}.`,
  )
  const message = 'Action skipped because the active mission changed.'
  if (userVisible) useMissionStore.getState().showToast(message, 'info')
  return new TransportError('identity_changed', message, undefined, userVisible)
}

function assertMutationContextActive(
  context: MutationContext,
  operation: string,
  userVisible = true,
) {
  if (!mutationContextIsActive(context)) {
    throw staleMutationError(context, operation, userVisible)
  }
}

async function mutationResponseBody<T>(
  response: Response,
  context: MutationContext,
  operation: string,
) {
  try {
    return (await response.json()) as T
  } finally {
    assertMutationContextActive(context, operation)
  }
}

async function mutationJsonResponse<T>(
  response: Response,
  context: MutationContext,
  operation: string,
) {
  try {
    return await jsonResponse<T>(response)
  } finally {
    assertMutationContextActive(context, operation)
  }
}

async function refreshSnapshot(candidate = identity) {
  if (!candidate) return
  const snapshot = await getSnapshot(candidate)
  if (!identityIsActive(candidate)) return
  calibrateClock(
    candidate,
    snapshot.bodyTimestamp,
    snapshot.receivedAt,
    snapshot.headerTimestamp,
  )
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

function resetTransportPenalties() {
  failedWebSockets = 0
  reconnectAttempt = 0
  digestRetryAttempt = 0
}

async function fetchServerDigest(context: MutationContext) {
  assertMutationContextActive(context, 'digest probe', false)
  const candidate = context.candidate
  if (!candidate) return
  const cursor = Number(context.cursor)
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
        'x-mg-session': context.sessionId,
        'x-mg-actor': 'browser_agent',
      },
      body: JSON.stringify({
        type: 'SELECTION_CHANGED',
        payload: { client_id: context.sessionId, selected: [] },
        idem_key: context.idemKey,
        base_seq: cursor - 1,
      }),
    },
  )
  const receivedAt = Date.now()
  assertMutationContextActive(context, 'digest response', false)
  calibrateClock(candidate, null, receivedAt, response.headers.get('date'))
  if (response.status === 409) {
    const stale = (await response.json()) as StaleBody
    assertMutationContextActive(context, 'digest 409 response', false)
    useMissionStore
      .getState()
      .applyServerDigest(candidate.client.project, stale.fresh_digest)
    digestRetryAttempt = 0
    return
  }
  if (!response.ok) await jsonResponse(response)
  throw new TransportError(
    'digest_probe_applied',
    'The authoritative digest probe unexpectedly appended a mutation.',
  )
}

function scheduleDigestAttempt(context: MutationContext, delay: number) {
  digestTimer = window.setTimeout(() => {
    digestTimer = null
    void fetchServerDigest(context).catch((error: unknown) => {
      if (!mutationContextIsActive(context)) return
      const candidate = context.candidate
      if (!candidate) return
      if (
        error instanceof TransportError &&
        identityFailureDisposition(candidate.source, error.status) !== 'retry'
      ) {
        void recoverExpiredIdentity(candidate, error.status).catch(
          enterFixtureWithRetry,
        )
        return
      }
      useMissionStore
        .getState()
        .markApprovalRankingStale(candidate.client.project)
      const retryDelay = digestRetryDelay(digestRetryAttempt++)
      if (retryDelay === null) {
        console.warn('[MissionGraph] Approval ranking refresh retries exhausted.')
        return
      }
      console.warn(
        `[MissionGraph] Approval ranking refresh failed; retrying in ${retryDelay}ms.`,
      )
      scheduleDigestAttempt(context, retryDelay)
    })
  }, delay)
}

function scheduleServerDigest(candidate: ActiveIdentity) {
  if (!identityIsActive(candidate)) return
  if (digestTimer !== null) window.clearTimeout(digestTimer)
  digestRetryAttempt = 0
  const context = captureMutationContext()
  if (Number(context.cursor) === 0) return
  useMissionStore
    .getState()
    .markApprovalRankingStale(candidate.client.project)
  scheduleDigestAttempt(context, 80)
}

async function refreshServerDigest(candidate: ActiveIdentity) {
  const context = captureMutationContext()
  if (Number(context.cursor) === 0) return
  useMissionStore
    .getState()
    .markApprovalRankingStale(candidate.client.project)
  try {
    await fetchServerDigest(context)
  } catch (error) {
    if (!mutationContextIsActive(context)) return
    if (
      error instanceof TransportError &&
      identityFailureDisposition(candidate.source, error.status) !== 'retry'
    ) {
      throw error
    }
    const retryDelay = digestRetryDelay(digestRetryAttempt++)
    if (retryDelay !== null) scheduleDigestAttempt(context, retryDelay)
  }
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
    resetTransportPenalties()
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
    calibrateClock(
      candidate,
      snapshot.bodyTimestamp,
      snapshot.receivedAt,
      snapshot.headerTimestamp,
    )
    useMissionStore
      .getState()
      .applySnapshot(
        snapshot.state,
        snapshot.cursor,
        candidate.client.project,
      )
    await refreshServerDigest(candidate)
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
    calibrateClock(identity!, data.event.ts, Date.now(), null, true)
    store.applyEvent(data.event)
    proveConnectionStable(stamp, true)
    scheduleServerDigest(identity!)
  } else {
    calibrateClock(
      identity!,
      latestSnapshotTimestamp(data.state),
      Date.now(),
    )
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

async function waitForSequence(seq: number, context: MutationContext) {
  const candidate = context.candidate
  if (!candidate) return
  const deadline = Date.now() + 1_500
  while (
    mutationContextIsActive(context) &&
    Number(useMissionStore.getState().cursor) < seq &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  }
  if (
    mutationContextIsActive(context) &&
    Number(useMissionStore.getState().cursor) < seq
  ) {
    await refreshSnapshot(candidate)
  }
  assertMutationContextActive(context, 'mutation completion')
}

function fixtureMutation<T extends EvType>(
  type: T,
  payload: EventPayloadMap[T],
  actor: Actor,
  context: MutationContext,
  offset = 0,
) {
  assertMutationContextActive(context, 'fixture mutation')
  if (!context.fixture) {
    throw new TransportError('not_connected', 'No live project is connected.')
  }
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
  const expectedCursor = Number(context.cursor) + offset
  if (Number(state.cursor) !== expectedCursor) {
    throw new TransportError(
      'stale_mutation',
      'The graph changed concurrently; retry this action.',
    )
  }
  const event = {
    seq: expectedCursor + 1,
    project_id: context.projectId ?? 'shorty-demo',
    ts: new Date().toISOString(),
    actor,
    type,
    payload,
    idem_key: offset === 0 ? context.idemKey : `${context.idemKey}:${offset}`,
  } as MissionEvent
  state.applyEvent(event)
  return event.seq
}

async function postMutation<T extends EvType>(
  type: T,
  payload: EventPayloadMap[T],
  actor: 'human' | 'browser_agent',
  context: MutationContext,
): Promise<number> {
  assertMutationContextActive(context, 'deferred mutation')
  if (context.fixture) {
    return fixtureMutation(type, payload, actor, context)
  }
  const candidate = context.candidate
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
        'x-mg-session': context.sessionId,
        'x-mg-actor': actor,
      },
      body: JSON.stringify({
        type,
        payload,
        idem_key: context.idemKey,
        base_seq: Number(context.cursor),
      }),
    },
  )
  assertMutationContextActive(context, 'mutation response')
  if (response.status === 409) {
    const stale = await mutationResponseBody<StaleBody>(
      response,
      context,
      'mutation 409 response',
    )
    useMissionStore
      .getState()
      .applyDigestChanges(
        candidate.client.project,
        stale.fresh_digest.changes_since as DigestChange[],
        stale.fresh_digest.cursor,
      )
    useMissionStore
      .getState()
      .applyServerDigest(candidate.client.project, stale.fresh_digest)
    await refreshSnapshot(candidate)
    assertMutationContextActive(context, 'mutation refresh')
    const error = new TransportError(
      'stale_mutation',
      'The graph changed concurrently; the live snapshot was refreshed.',
    )
    if (context.staleMode === 'error') {
      useMissionStore.getState().showToast(error.message, 'error')
    }
    throw error
  }
  const result = await mutationJsonResponse<MutationResponse>(
    response,
    context,
    'mutation result',
  )
  await waitForSequence(result.seq, context)
  return result.seq
}

async function postMutationBatch(
  batch: MutationBatchItem[],
  actor: 'human' | 'browser_agent',
  context: MutationContext,
): Promise<number[]> {
  assertMutationContextActive(context, 'deferred batch mutation')
  if (context.fixture) {
    return batch.map((item, index) =>
      fixtureMutation(item.type, item.payload, actor, context, index),
    )
  }
  const candidate = context.candidate
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
        'x-mg-session': context.sessionId,
        'x-mg-actor': actor,
      },
      body: JSON.stringify({
        batch,
        idem_key: context.idemKey,
        base_seq: Number(context.cursor),
      }),
    },
  )
  assertMutationContextActive(context, 'batch mutation response')
  if (response.status === 409) {
    const stale = await mutationResponseBody<StaleBody>(
      response,
      context,
      'batch mutation 409 response',
    )
    useMissionStore
      .getState()
      .applyDigestChanges(
        candidate.client.project,
        stale.fresh_digest.changes_since as DigestChange[],
        stale.fresh_digest.cursor,
      )
    useMissionStore
      .getState()
      .applyServerDigest(candidate.client.project, stale.fresh_digest)
    await refreshSnapshot(candidate)
    assertMutationContextActive(context, 'batch mutation refresh')
    const error = new TransportError(
      'stale_mutation',
      'The graph changed concurrently; the live snapshot was refreshed.',
    )
    if (context.staleMode === 'error') {
      useMissionStore.getState().showToast(error.message, 'error')
    }
    throw error
  }
  const result = await mutationJsonResponse<BatchMutationResponse>(
    response,
    context,
    'batch mutation result',
  )
  if (result.seqs.length > 0) {
    await waitForSequence(result.seqs.at(-1)!, context)
    try {
      await loadChangesSince(context.cursor, candidate)
    } finally {
      assertMutationContextActive(context, 'batch history result')
    }
  }
  return result.seqs
}

function enqueueMutation<T extends EvType>(
  type: T,
  payload: EventPayloadMap[T],
  actor: 'human' | 'browser_agent',
  context: MutationContext,
) {
  const queued = mutationQueue.then(() =>
    postMutation(type, payload, actor, context),
  )
  mutationQueue = queued.then(
    () => undefined,
    () => undefined,
  )
  return queued
}

export function prepareMutation<T extends EvType>(
  type: T,
  payload: EventPayloadMap[T],
  options: Pick<MutationOptions, 'actor' | 'staleMode'> = {},
) {
  const actor = options.actor ?? 'human'
  const context = captureMutationContext(options.staleMode)
  return () => enqueueMutation(type, payload, actor, context)
}

export function mutate<T extends EvType>(
  type: T,
  payload: EventPayloadMap[T],
  options: MutationOptions = {},
): Promise<number> {
  const actor = options.actor ?? 'human'
  if (options.debounceKey) {
    return mutationDebouncer.schedule(
      options.debounceKey,
      300,
      Number(useMissionStore.getState().cursor),
      () => {
        const context = captureMutationContext(options.staleMode)
        return enqueueMutation(type, payload, actor, context)
      },
    )
  }
  const context = captureMutationContext(options.staleMode)
  return enqueueMutation(type, payload, actor, context)
}

export function mutateBatch(
  batch: MutationBatchItem[],
  options: Pick<MutationOptions, 'actor' | 'staleMode'> = {},
): Promise<number[]> {
  const actor = options.actor ?? 'human'
  const context = captureMutationContext(options.staleMode)
  const queued = mutationQueue.then(() =>
    postMutationBatch(batch, actor, context),
  )
  mutationQueue = queued.then(
    () => undefined,
    () => undefined,
  )
  return queued
}

export function prepareBatchMutation(
  batch: MutationBatchItem[],
  options: Pick<MutationOptions, 'actor' | 'staleMode'> = {},
) {
  const actor = options.actor ?? 'human'
  const context = captureMutationContext(options.staleMode)
  return () => {
    const queued = mutationQueue.then(() =>
      postMutationBatch(batch, actor, context),
    )
    mutationQueue = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }
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
  configureMutationSender(mutate, prepareMutation)
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
  calibrateClock(
    candidate,
    snapshot.bodyTimestamp,
    snapshot.receivedAt,
    snapshot.headerTimestamp,
  )
  const store = useMissionStore.getState()
  store.applySnapshot(snapshot.state, snapshot.cursor, client.project)
  await refreshServerDigest(candidate)
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
  resetTransportPenalties()
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
