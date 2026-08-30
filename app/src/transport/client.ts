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

const DEFAULT_SERVER = 'http://127.0.0.1:31337'
const SESSION_KEY = 'missiongraph.session-id'

interface ClientIdentity {
  project: string
  token: string
}

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

const logicalServer = (import.meta.env.VITE_MG_SERVER ?? DEFAULT_SERVER).replace(
  /\/$/,
  '',
)
const requestBase = import.meta.env.DEV ? '/mg' : logicalServer
const debounceTimers = new Map<
  string,
  { timer: number; resolve: (cursor: number) => void }
>()
let identity: ClientIdentity | null = null
let seededDevProject = false
let socket: WebSocket | null = null
let reconnectTimer: number | null = null
let mutationQueue = Promise.resolve()
let initialization: Promise<void> | null = null

function sessionId() {
  const existing = sessionStorage.getItem(SESSION_KEY)
  if (existing) return existing
  const created = crypto.randomUUID()
  sessionStorage.setItem(SESSION_KEY, created)
  return created
}

function endpoint(path: string) {
  return `${requestBase}${path}`
}

function websocketEndpoint(client: ClientIdentity, cursor: string) {
  const query = new URLSearchParams({
    project: client.project,
    from_seq: cursor,
    token: client.token,
  })
  if (import.meta.env.DEV) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}/mg/ws?${query}`
  }
  const url = new URL(logicalServer)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
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
  if (seededDevProject) {
    useMissionStore
      .getState()
      .setConnectionMode('live', 'Live dev seed · fixture projection')
  }
}

function openSocket() {
  if (!identity) return
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  socket?.close()
  const cursor = useMissionStore.getState().cursor
  socket = new WebSocket(websocketEndpoint(identity, cursor))
  socket.addEventListener('message', (message) => {
    const data = JSON.parse(String(message.data)) as
      | { kind: 'event'; event: MissionEvent }
      | { kind: 'snapshot'; state: GraphSnapshotState; cursor: string }
    if (data.kind === 'event') {
      useMissionStore.getState().applyEvent(data.event)
    } else if (identity) {
      useMissionStore
        .getState()
        .applySnapshot(data.state, data.cursor, identity.project)
    }
  })
  socket.addEventListener('open', () => {
    useMissionStore
      .getState()
      .setConnectionMode(
        'live',
        seededDevProject ? 'Live dev seed · fixture projection' : 'Live server',
      )
  })
  socket.addEventListener('close', () => {
    if (!identity) return
    useMissionStore
      .getState()
      .setConnectionMode('live', 'Live server · reconnecting')
    reconnectTimer = window.setTimeout(openSocket, 900)
  })
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
  retry = true,
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
    if (retry) return postMutation(type, payload, actor, false)
    throw new TransportError(
      'stale_sequence',
      'The graph changed concurrently; the live snapshot was refreshed.',
    )
  }
  const result = await jsonResponse<MutationResponse>(response)
  await waitForSequence(result.seq)
  return result.seq
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

function seededIdentityFromUrl(): ClientIdentity | null {
  if (!import.meta.env.DEV) return null
  const params = new URLSearchParams(window.location.search)
  const project = params.get('mg_project')
  const token = params.get('mg_token')
  return project && token ? { project, token } : null
}

async function bootstrap() {
  const store = useMissionStore.getState()
  store.setSessionId(sessionId())
  configureMutationSender(mutate)
  try {
    const seededIdentity = seededIdentityFromUrl()
    seededDevProject = seededIdentity !== null
    identity = seededIdentity ?? (await cloneDemo())
    const snapshot = await getSnapshot(identity)
    store.applySnapshot(snapshot.state, snapshot.cursor, identity.project)
    if (seededIdentity) {
      store.setConnectionMode('live', 'Live dev seed · fixture projection')
    }
    openSocket()
  } catch (error) {
    identity = null
    const message =
      error instanceof Error ? error.message : 'The live server is unreachable.'
    store.useFixture(`Offline fixture · ${message}`)
  }
}

export function initializeMissionClient() {
  initialization ??= bootstrap()
  return initialization
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
  await new Promise<void>((resolve, reject) => {
    const historySocket = new WebSocket(websocketEndpoint(identity!, since))
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
      reject(new TransportError('history_unavailable', 'Graph history is unavailable.'))
    })
  })
}
