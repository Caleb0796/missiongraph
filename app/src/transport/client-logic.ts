export interface ClientIdentity {
  project: string
  token: string
}

export type IdentitySource = 'url' | 'stored'

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
  return Number.isNaN(serverTime) ? 0 : serverTime - receivedAt
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
