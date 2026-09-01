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

export interface LiveFleetDisplay {
  nodeId: string
  phase: 'queued' | 'starting' | 'degraded'
  position?: number
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
  schedule?: (callback: () => void, milliseconds: number) => unknown
  cancel?: (timer: unknown) => void
  pollMilliseconds?: number
}

interface ActiveFleetRequest {
  id: string
  nodeId: string
}

export function liveFleetDisplayText(display: LiveFleetDisplay) {
  if (display.phase === 'degraded') return LIVE_FLEET_BUSY_COPY
  if (display.phase === 'starting') return 'Live fleet: worker starting'
  return `Live fleet: queued${display.position === undefined ? '' : ` (#${display.position})`}`
}

export function withFleetMetadata<T extends Record<string, unknown>>(
  data: T,
  fleet: FleetMetadata | null,
): T | (T & { fleet: FleetMetadata }) {
  return fleet ? { ...data, fleet } : data
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
  private readonly schedule: NonNullable<FleetCoordinatorOptions['schedule']>
  private readonly cancel: NonNullable<FleetCoordinatorOptions['cancel']>
  private readonly pollMilliseconds: number
  private readonly statusBySession = new Map<string, Promise<FleetStatusResponse>>()
  private readonly dispatches = new Map<string, Promise<FleetMetadata | null>>()
  private session: FleetSession | null = null
  private request: ActiveFleetRequest | null = null
  private timer: unknown = null
  private generation = 0
  private mounted = true
  private degradationShown = false

  constructor(options: FleetCoordinatorOptions) {
    this.transport = options.transport
    this.onDisplay = options.onDisplay
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
    this.generation++
  }

  dispatch(nodeId: string) {
    if (!this.mounted || !this.session) return Promise.resolve(null)
    const existing = this.dispatches.get(nodeId)
    if (existing) return existing
    const pending = this.startDispatch(nodeId)
    this.dispatches.set(nodeId, pending)
    return pending
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

  private probe(session: FleetSession) {
    const key = this.sessionKey(session)
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

  private async startDispatch(nodeId: string): Promise<FleetMetadata | null> {
    const session = this.session
    if (!session) return null
    const generation = this.generation
    try {
      const status = await this.probe(session)
      if (!this.isCurrent(session, generation) || !status.enabled) return null
      const request = await this.transport.create(session, nodeId)
      if (!this.isCurrent(session, generation)) return null
      this.request = { id: request.id, nodeId }
      this.degradationShown = false
      this.showRequest(request, nodeId)
      this.schedulePoll(session, generation)
      return {
        status: request.status,
        ...(request.position === undefined ? {} : { position: request.position }),
      }
    } catch {
      if (this.isCurrent(session, generation)) this.degrade(nodeId)
      return null
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

  private degrade(nodeId: string) {
    this.clearTimer()
    this.request = null
    if (this.degradationShown) return
    this.degradationShown = true
    this.onDisplay({ nodeId, phase: 'degraded' })
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
