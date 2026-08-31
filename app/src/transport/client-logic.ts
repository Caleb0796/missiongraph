import type { DigestChange, MissionEvent } from '../model/types'

export interface ClientIdentity {
  project: string
  token: string
}

export type IdentitySource = 'url' | 'stored'

export interface ProjectCursor {
  projectId: string | null
  cursor: string
}

type ProjectStorage = Pick<Storage, 'getItem' | 'setItem'>
type ClipboardDocument = Pick<Document, 'body' | 'createElement' | 'execCommand'>

const FIRST_RUN_PREFIX = 'missiongraph.first-run.'

function firstRunKey(projectId: string) {
  return `${FIRST_RUN_PREFIX}${projectId}`
}

export function claimFirstRunPrompts(
  projectId: string,
  storage: ProjectStorage = localStorage,
) {
  try {
    const key = firstRunKey(projectId)
    if (storage.getItem(key) !== null) return false
    storage.setItem(key, 'seen')
    return true
  } catch {
    return true
  }
}

export function dismissFirstRunPrompts(
  projectId: string,
  storage: ProjectStorage = localStorage,
) {
  try {
    storage.setItem(firstRunKey(projectId), 'dismissed')
  } catch {
    // The panel still closes when browser storage is unavailable.
  }
}

export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = navigator.clipboard,
  documentRef: ClipboardDocument = document,
) {
  try {
    if (clipboard?.writeText) {
      await clipboard.writeText(text)
      return true
    }
  } catch {
    // Try the synchronous browser fallback below.
  }
  let textarea: HTMLTextAreaElement | null = null
  try {
    textarea = documentRef.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    documentRef.body.append(textarea)
    textarea.select()
    return documentRef.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea?.remove()
  }
}

export function parseStoredIdentity(value: string | null): ClientIdentity | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return typeof parsed.project === 'string' &&
      parsed.project.length > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0
      ? { project: parsed.project, token: parsed.token }
      : null
  } catch {
    return null
  }
}

export function configuredServer(
  value: string | undefined,
  development: boolean,
) {
  const candidate = value?.replace(/\/$/, '')
  if (development) {
    return {
      logicalServer: candidate ?? 'http://127.0.0.1:31337',
      requestBase: '/mg',
    }
  }
  if (!candidate) return { logicalServer: null, requestBase: null }
  const parsed = new URL(candidate)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('VITE_MG_SERVER must be an absolute HTTP(S) URL.')
  }
  return { logicalServer: candidate, requestBase: candidate }
}

export function isIdentityAuthStatus(status: number | undefined) {
  return status === 401 || status === 404
}

export function identityFailureDisposition(
  source: IdentitySource,
  status: number | undefined,
) {
  if (!isIdentityAuthStatus(status)) return 'retry' as const
  return source === 'url' ? ('invalid-link' as const) : ('replace-stored' as const)
}

export function eventBelongsToProject(
  currentProject: string | null,
  eventProject: string,
) {
  return currentProject !== null && currentProject === eventProject
}

export function shouldApplySnapshot(
  currentProject: string | null,
  currentCursor: string,
  incomingProject: string,
  incomingCursor: string,
) {
  return (
    currentProject !== incomingProject ||
    Number(incomingCursor) >= Number(currentCursor)
  )
}

export function shouldApplyDigest(
  currentProject: string | null,
  currentCursor: string,
  incomingProject: string,
  incomingCursor: string,
) {
  return (
    currentProject === incomingProject &&
    Number(incomingCursor) >= Number(currentCursor)
  )
}

export function mutationEpochMatches(
  capturedEpoch: number,
  capturedProject: string | null,
  activeEpoch: number,
  activeProject: string | null,
) {
  return capturedEpoch === activeEpoch && capturedProject === activeProject
}

export function toolCursorForProject(
  clientCursor: ProjectCursor | null,
  projectId: string | null,
  storeCursor: string,
) {
  if (!clientCursor) return storeCursor
  return clientCursor.projectId === projectId ? clientCursor.cursor : '0'
}

export function realtimeTransport(failedWebSockets: number) {
  return failedWebSockets >= 3 ? 'sse' : 'websocket'
}

export function reconnectDelay(
  attempt: number,
  random: () => number = Math.random,
) {
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt))
  return Math.round(base * (0.75 + random() * 0.5))
}

export function bootstrapRetryDelay(attempt: number) {
  return [5_000, 15_000, 30_000][attempt] ?? 60_000
}

export function digestRetryDelay(attempt: number) {
  return [500, 1_500, 5_000, 15_000][attempt] ?? null
}

export function connectionProvedStable(
  openedAt: number,
  now: number,
  receivedLiveEvent: boolean,
) {
  return receivedLiveEvent || now - openedAt >= 30_000
}

export function estimateClockSkew(serverTimestamp: string | null, receivedAt: number) {
  if (!serverTimestamp) return 0
  const serverTime = Date.parse(serverTimestamp)
  if (Number.isNaN(serverTime)) return 0
  const offset = serverTime - receivedAt
  return Math.abs(offset) > 24 * 60 * 60_000 ? 0 : offset
}

export function clockSampleIsFresh(
  sampledAt: number | null,
  now: number,
  maxAgeMs = 5 * 60_000,
) {
  return sampledAt !== null && now - sampledAt >= 0 && now - sampledAt < maxAgeMs
}

export function skewCorrectedNow(localNow: number, skewMs: number) {
  return localNow + skewMs
}

export function sequenceDisposition(cursor: string, incoming: number) {
  const current = Number(cursor)
  if (incoming <= current) return 'duplicate' as const
  if (incoming === current + 1) return 'next' as const
  return 'gap' as const
}

export function safeDigestMetadata(
  event: MissionEvent,
): Partial<Pick<DigestChange, 'policy_ref' | 'authorization'>> {
  if (event.type === 'POLICY_STATED') {
    return { policy_ref: event.payload.policy_ref }
  }
  if (
    (event.type === 'APPROVED' || event.type === 'REJECTED') &&
    event.payload.authorization
  ) {
    return {
      authorization: {
        capability_ref: event.payload.authorization.capability_ref,
        use_nonce: event.payload.authorization.use_nonce,
      },
    }
  }
  return {}
}

export async function recoverSequenceAfterSnapshot(
  preMutationCursor: string,
  refreshSnapshot: () => Promise<void>,
  replayChanges: (since: string) => Promise<void>,
) {
  await refreshSnapshot()
  await replayChanges(preMutationCursor)
}
