export interface ClientIdentity {
  project: string
  token: string
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

export function shouldReplaceStoredIdentity(code: string) {
  return code === 'http_401' || code === 'http_404' || code === 'project_not_found'
}

export function realtimeTransport(failedWebSockets: number) {
  return failedWebSockets >= 3 ? 'sse' : 'websocket'
}
