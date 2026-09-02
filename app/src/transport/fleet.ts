import type { MissionEvent } from '../model/types'

export const LIVE_FLEET_BUSY_COPY =
  'The shared live fleet is busy right now — live execution is demonstrated in the video.'

export type FleetRequestStatus =
  | 'queued'
  | 'adopted'
  | 'running'
  | 'done'
  | 'failed'
  | 'expired'

export interface FleetMetadata {
  status: FleetRequestStatus
  position?: number
}

export interface FleetEnqueueError {
  code: string
  reason: string
}

export interface FleetRejection {
  status: 'rejected'
  error: FleetEnqueueError
}

export type FleetDispatchMetadata = FleetMetadata | FleetRejection

export interface LiveFleetDisplay {
  nodeId: string
  phase: 'queued' | 'starting' | 'degraded'
  position?: number
  error?: FleetEnqueueError
}

interface FleetSession {
  project: string
  token: string
  sessionId: string
}

interface FleetStatusResponse {
  enabled: boolean
  queue_depth: number
  daily_remaining: number
  project_remaining: number
  eligible_node_ids: string[]
}

interface FleetRequestResponse extends FleetMetadata {
  id: string
}

interface FleetTransport {
  status: (session: FleetSession) => Promise<FleetStatusResponse>
  create: (session: FleetSession, nodeId: string) => Promise<FleetRequestResponse>
  get: (session: FleetSession, requestId: string) => Promise<FleetRequestResponse>
}

interface FleetCoordinatorOptions {
  transport: FleetTransport
  onDisplay: (display: LiveFleetDisplay | null) => void
  onEligibility?: (nodeIds: string[]) => void
  schedule?: (callback: () => void, milliseconds: number) => unknown
  cancel?: (timer: unknown) => void
  pollMilliseconds?: number
}

interface ActiveFleetRequest {
  id: string
  nodeId: string
}

export function liveFleetDisplayText(display: LiveFleetDisplay) {
  if (display.phase === 'degraded') {
    if (display.error?.code === 'template_mismatch') {
      return `Live fleet: supervision-only for this task — ${display.error.reason}`
    }
    if (
      display.error?.code === 'fleet_daily_cap' ||
      display.error?.code === 'fleet_project_cap'
    ) {
      return `Live fleet: capacity unavailable (${display.error.code}) — ${display.error.reason}`
    }
    return LIVE_FLEET_BUSY_COPY
  }
  if (display.phase === 'starting') return 'Live fleet: worker starting'
  return `Live fleet: queued${display.position === undefined ? '' : ` (#${display.position})`}`
}

export function withFleetMetadata<T extends Record<string, unknown>>(
  data: T,
  fleet: FleetDispatchMetadata | null,
): T | (T & { fleet: FleetDispatchMetadata }) {
  return fleet ? { ...data, fleet } : data
}

function fleetEnqueueError(error: unknown): FleetEnqueueError {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : 'fleet_unavailable'
  const reason =
    error instanceof Error
      ? error.message
      : 'The live fleet request could not be created.'
  return { code, reason }
}

export function isFleetWorkerEvent(event: MissionEvent) {
  switch (event.type) {
    case 'NODE_STATE_CHANGED':
    case 'WORKER_LOG':
    case 'HANDOFF_FILED':
    case 'APPROVAL_CREATED':
      return event.payload.node_id
    default:
      return null
  }
}

export class LiveFleetCoordinator {
  private readonly transport: FleetTransport
  private readonly onDisplay: FleetCoordinatorOptions['onDisplay']
  private readonly onEligibility: NonNullable<FleetCoordinatorOptions['onEligibility']>
  private readonly schedule: NonNullable<FleetCoordinatorOptions['schedule']>
  private readonly cancel: NonNullable<FleetCoordinatorOptions['cancel']>
  private readonly pollMilliseconds: number
  private readonly statusBySession = new Map<string, Promise<FleetStatusResponse>>()
  private readonly eligibilityRefreshes = new Map<string, Promise<void>>()
  private readonly dispatches = new Map<string, Promise<FleetDispatchMetadata | null>>()
  private readonly results = new Map<string, FleetDispatchMetadata | null>()
  private session: FleetSession | null = null
  private request: ActiveFleetRequest | null = null
  private timer: unknown = null
  private generation = 0
  private mounted = true
  private degradationShown = false
  private eligibilityCursor: string | null = null

  constructor(options: FleetCoordinatorOptions) {
    this.transport = options.transport
    this.onDisplay = options.onDisplay
    this.onEligibility = options.onEligibility ?? (() => {})
    this.schedule = options.schedule ?? ((callback, milliseconds) => setTimeout(callback, milliseconds))
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
    this.pollMilliseconds = options.pollMilliseconds ?? 10_000
  }

  setMounted(mounted: boolean) {
    this.mounted = mounted
    if (!mounted) this.stop(true)
  }

  activate(session: FleetSession | null) {
    const unchanged =
      this.session?.project === session?.project &&
      this.session?.sessionId === session?.sessionId &&
      this.session?.token === session?.token
    if (unchanged) return
    this.stop(true)
    this.session = session
    this.dispatches.clear()
    this.results.clear()
    this.eligibilityCursor = null
    this.onEligibility([])
    this.generation++
  }

  refreshEligibility(cursor: string): Promise<void> {
    if (!this.mounted || !this.session) return Promise.resolve()
    const session = this.session
    const generation = this.generation
    this.eligibilityCursor = cursor
    const key = `${this.sessionKey(session)}:${cursor}`
    const existing = this.eligibilityRefreshes.get(key)
    if (existing) return existing
    const pending = this.probe(session, cursor)
      .then((status) => {
        if (
          !this.isCurrent(session, generation) ||
          this.eligibilityCursor !== cursor
        ) {
          return
        }
        this.onEligibility(
          status.enabled ? (status.eligible_node_ids ?? []) : [],
        )
      })
      .catch(() => {
        // Eligibility is advisory; retain the last successful projection.
      })
    this.eligibilityRefreshes.set(key, pending)
    return pending
  }

  dispatch(nodeId: string) {
    if (!this.mounted || !this.session) return Promise.resolve(null)
    const existing = this.dispatches.get(nodeId)
    if (existing) return existing
    const pending = this.startDispatch(nodeId)
    this.dispatches.set(nodeId, pending)
    return pending
  }

  resultForDispatch(nodeId: string) {
    return this.results.get(nodeId) ?? null
  }

  noteLedgerEvent(event: MissionEvent) {
    if (
      !this.request ||
      event.project_id !== this.session?.project ||
      isFleetWorkerEvent(event) !== this.request.nodeId
    ) {
      return
    }
    this.stop(true)
  }

  private sessionKey(session: FleetSession) {
    return `${session.project}:${session.sessionId}`
  }

  private probe(session: FleetSession, cursor = this.eligibilityCursor ?? 'session') {
    const key = `${this.sessionKey(session)}:${cursor}`
    const cached = this.statusBySession.get(key)
    if (cached) return cached
    const pending = this.transport.status(session)
    this.statusBySession.set(key, pending)
    return pending
  }

  private isCurrent(session: FleetSession, generation: number) {
    return (
      this.mounted &&
      this.generation === generation &&
      this.session?.project === session.project &&
      this.session.sessionId === session.sessionId
    )
  }

  private async startDispatch(nodeId: string): Promise<FleetDispatchMetadata | null> {
    const session = this.session
    if (!session) return null
    const generation = this.generation
    let status: FleetStatusResponse
    try {
      status = await this.probe(session)
    } catch {
      return null
    }
    if (!this.isCurrent(session, generation)) return null
    if (!status.enabled) {
      this.results.set(nodeId, null)
      return null
    }
    try {
      const request = await this.transport.create(session, nodeId)
      if (!this.isCurrent(session, generation)) return null
      this.request = { id: request.id, nodeId }
      this.degradationShown = false
      this.showRequest(request, nodeId)
      this.schedulePoll(session, generation)
      const result: FleetMetadata = {
        status: request.status,
        ...(request.position === undefined ? {} : { position: request.position }),
      }
      this.results.set(nodeId, result)
      return result
    } catch (error) {
      if (!this.isCurrent(session, generation)) return null
      const rejection: FleetRejection = {
        status: 'rejected',
        error: fleetEnqueueError(error),
      }
      this.results.set(nodeId, rejection)
      this.degrade(nodeId, rejection.error)
      return rejection
    }
  }

  private showRequest(request: FleetRequestResponse, nodeId: string) {
    if (request.status === 'queued') {
      this.onDisplay({
        nodeId,
        phase: 'queued',
        ...(request.position === undefined ? {} : { position: request.position }),
      })
      return
    }
    if (request.status === 'adopted' || request.status === 'running') {
      this.onDisplay({ nodeId, phase: 'starting' })
    }
  }

  private schedulePoll(session: FleetSession, generation: number) {
    this.clearTimer()
    this.timer = this.schedule(() => {
      this.timer = null
      void this.poll(session, generation)
    }, this.pollMilliseconds)
  }

  private async poll(session: FleetSession, generation: number) {
    const active = this.request
    if (!active || !this.isCurrent(session, generation)) return
    try {
      const request = await this.transport.get(session, active.id)
      if (!this.isCurrent(session, generation) || this.request?.id !== active.id) return
      if (request.status === 'done') {
        this.stop(true)
        return
      }
      if (request.status === 'failed' || request.status === 'expired') {
        this.degrade(active.nodeId)
        return
      }
      this.showRequest(request, active.nodeId)
      this.schedulePoll(session, generation)
    } catch {
      if (this.isCurrent(session, generation)) this.degrade(active.nodeId)
    }
  }

  private degrade(nodeId: string, error?: FleetEnqueueError) {
    this.clearTimer()
    this.request = null
    if (this.degradationShown) return
    this.degradationShown = true
    this.onDisplay({ nodeId, phase: 'degraded', ...(error ? { error } : {}) })
  }

  private clearTimer() {
    if (this.timer === null) return
    this.cancel(this.timer)
    this.timer = null
  }

  private stop(clearDisplay: boolean) {
    this.clearTimer()
    this.request = null
    this.degradationShown = false
    if (clearDisplay) this.onDisplay(null)
  }
}
