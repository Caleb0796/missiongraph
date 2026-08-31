import { create } from 'zustand'
import {
  shortyApprovals,
  shortyEvents,
  shortyReadySince,
} from '../fixtures/shorty-dag'
import {
  boundedHistory,
  describeEvent,
  fixtureRankedPendingApprovals,
  getBlastRadius,
  getCriticalPath,
  isNonIdle,
  isPreviewStale,
  refreshReadySince,
  wouldCreateCycle,
} from '../model/graph'
import type {
  Approval,
  DigestChange,
  EventPayloadMap,
  EvType,
  GraphEdge,
  GraphDigest,
  GraphSnapshotState,
  Handoff,
  MissionEvent,
  TaskNode,
} from '../model/types'
import {
  eventBelongsToProject,
  shouldApplyDigest,
  shouldApplySnapshot,
} from '../transport/client-logic'

interface Point {
  x: number
  y: number
}

interface Toast {
  id: string
  tone: 'info' | 'error'
  message: string
  caption?: string
}

interface CameraRequest {
  id: string
  nodeIds: string[]
}

interface StructuralPreview {
  title: string
  baseCursor: string
  blastRadius: { stale: string[]; pausing: string[] }
}

export type ConnectionMode = 'loading' | 'live' | 'fixture' | 'link-error'

export interface MutationOptions {
  actor?: 'human' | 'browser_agent'
  debounceKey?: string
}

export type MutationSender = <T extends EvType>(
  type: T,
  payload: EventPayloadMap[T],
  options?: MutationOptions,
) => Promise<number>

export type MutationPreparer = <T extends EvType>(
  type: T,
  payload: EventPayloadMap[T],
  options?: MutationOptions,
) => () => Promise<number>

interface MissionState {
  nodes: TaskNode[]
  edges: GraphEdge[]
  events: MissionEvent[]
  changes: DigestChange[]
  positions: Record<string, Point>
  tombstones: string[]
  approvals: Record<string, Approval>
  approvalRanking: GraphDigest['summary']['pending_approvals']
  approvalRankingSource: 'server' | 'fixture' | 'pending'
  approvalRankingStale: boolean
  policies: GraphSnapshotState['policies']
  annotations: GraphSnapshotState['annotations']
  handoffs: Record<string, Handoff>
  deviations: GraphSnapshotState['deviations']
  workerLogs: Record<string, string[]>
  selectedId: string | null
  highlightedIds: string[]
  cameraRequest: CameraRequest | null
  toast: Toast | null
  structuralPreview: StructuralPreview | null
  readySince: Record<string, string>
  projectId: string | null
  cursor: string
  connectionMode: ConnectionMode
  connectionMessage: string
  sessionId: string
  clockSkewMs: number
  linkErrorHasStoredIdentity: boolean
  hydratePositions: (positions: Record<string, Point>) => void
  applySnapshot: (
    snapshot: GraphSnapshotState,
    cursor: string,
    projectId: string,
  ) => void
  applyEvent: (event: MissionEvent) => void
  recordHistoricalEvent: (event: MissionEvent) => void
  applyDigestChanges: (
    projectId: string,
    changes: DigestChange[],
    cursor: string,
  ) => void
  applyServerDigest: (projectId: string, digest: GraphDigest) => void
  markApprovalRankingStale: (projectId: string) => void
  useFixture: (message: string) => void
  setConnectionMode: (mode: ConnectionMode, message: string) => void
  setClockSkew: (clockSkewMs: number) => void
  showInvalidMissionLink: (hasStoredIdentity: boolean) => void
  setSessionId: (sessionId: string) => void
  moveNode: (nodeId: string, point: Point) => void
  connectNodes: (upstream: string, downstream: string) => boolean
  removeSelected: () => void
  confirmStructural: () => void
  cancelStructural: () => void
  select: (id: string | null) => void
  approve: (nodeId: string, policyRef?: string) => void
  reject: (nodeId: string, policyRef?: string) => void
  dispatch: (nodeId: string) => void
  setHighlights: (ids: string[]) => void
  requestCamera: (ids: string[]) => void
  showToast: (message: string, tone?: Toast['tone'], caption?: string) => void
  clearToast: () => void
}

let mutationSender: MutationSender | null = null
let mutationPreparer: MutationPreparer | null = null
let pendingStructuralOperation: {
  title: string
  ids: string[]
  baseCursor: string
  apply: () => Promise<number>
} | null = null

export function configureMutationSender(
  sender: MutationSender,
  preparer: MutationPreparer,
) {
  mutationSender = sender
  mutationPreparer = preparer
}

function sendMutation<T extends EvType>(
  type: T,
  payload: EventPayloadMap[T],
  options?: MutationOptions,
) {
  if (!mutationSender) {
    return Promise.reject(new Error('MissionGraph transport is not ready.'))
  }
  return mutationSender(type, payload, options)
}

function prepareStoreMutation<T extends EvType>(
  type: T,
  payload: EventPayloadMap[T],
  options?: MutationOptions,
) {
  if (!mutationPreparer) {
    return () => Promise.reject(new Error('MissionGraph transport is not ready.'))
  }
  return mutationPreparer(type, payload, options)
}

function mutationErrorWasNotified(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'notified' in error &&
    error.notified === true
  )
}

function reportMutationError(error: unknown, state: MissionState) {
  if (mutationErrorWasNotified(error)) return
  state.showToast(
    error instanceof Error ? error.message : String(error),
    'error',
  )
}

function fixtureState() {
  const nodeById = new Map<string, TaskNode>()
  const edgeById = new Map<string, GraphEdge>()
  const positions: Record<string, Point> = {}
  const tombstones: string[] = []
  const handoffs: Record<string, Handoff> = {}
  const deviations: GraphSnapshotState['deviations'] = {}
  const workerLogs: Record<string, string[]> = {}
  const annotations: GraphSnapshotState['annotations'] = {}
  const policies: GraphSnapshotState['policies'] = {}

  for (const event of shortyEvents) {
    switch (event.type) {
      case 'TASK_ADDED':
        nodeById.set(event.payload.node.id, event.payload.node)
        break
      case 'TASK_REMOVED':
        nodeById.delete(event.payload.node_id)
        tombstones.push(event.payload.node_id)
        break
      case 'EDGE_ADDED':
        edgeById.set(event.payload.edge_id, event.payload)
        break
      case 'EDGE_REMOVED':
        edgeById.delete(event.payload.edge_id)
        break
      case 'NODE_STATE_CHANGED': {
        const node = nodeById.get(event.payload.node_id)
        if (node) nodeById.set(node.id, { ...node, state: event.payload.to })
        break
      }
      case 'APPROVED': {
        const node = nodeById.get(event.payload.node_id)
        if (node) nodeById.set(node.id, { ...node, state: 'done' })
        break
      }
      case 'REJECTED': {
        const node = nodeById.get(event.payload.node_id)
        if (node) nodeById.set(node.id, { ...node, state: 'running' })
        break
      }
      case 'POLICY_STATED':
        policies[event.payload.policy_ref] = {
          text: event.payload.text,
          session_id: event.payload.session_id,
          stated_at: event.ts,
        }
        break
      case 'ANNOTATED':
        ;(annotations[event.payload.target_id] ??= []).push({
          actor: event.actor,
          note: event.payload.note,
          ts: event.ts,
        })
        break
      case 'HANDOFF_FILED':
        handoffs[event.payload.node_id] = event.payload.handoff
        break
      case 'DEVIATION_NOTED':
        ;(deviations[event.payload.node_id] ??= []).push({
          ...event.payload,
          ts: event.ts,
        })
        break
      case 'WORKER_LOG':
        workerLogs[event.payload.node_id] = [
          ...(workerLogs[event.payload.node_id] ?? []),
          ...event.payload.lines,
        ]
        break
      case 'NODE_MOVED':
        positions[event.payload.node_id] = {
          x: event.payload.x,
          y: event.payload.y,
        }
        break
    }
  }

  const approvals = Object.fromEntries(
    shortyApprovals.map((approval, index) => [
      approval.id,
      {
        id: approval.id,
        node_id: approval.node_id,
        summary: approval.summary,
        created_at: new Date(Date.now() - approval.age_min * 60_000).toISOString(),
        created_seq: shortyEvents.length + index,
        status: 'pending' as const,
        tests: 'green' as const,
      },
    ]),
  )
  const nodes = [...nodeById.values()]
  const edges = [...edgeById.values()]
  const approvalRanking = fixtureRankedPendingApprovals(
    approvals,
    nodes,
    edges,
  ).map((approval) => ({
    approval_id: approval.id,
    node_id: approval.node_id,
    node_title:
      nodes.find((node) => node.id === approval.node_id)?.title ?? approval.node_id,
    summary: approval.summary,
    delay_impact_min: approval.delayImpactMin,
    age_since: approval.created_at,
  }))

  return {
    nodes,
    edges,
    positions,
    tombstones,
    approvals,
    approvalRanking,
    approvalRankingSource: 'fixture' as const,
    approvalRankingStale: false,
    policies,
    annotations,
    handoffs,
    deviations,
    workerLogs,
  }
}

const initial = fixtureState()

function snapshotToView(snapshot: GraphSnapshotState) {
  return {
    nodes: Object.values(snapshot.nodes).filter(
      (node) => node.record_type === 'task',
    ),
    edges: Object.values(snapshot.edges).map((edge) => ({
      edge_id: edge.id,
      upstream: edge.upstream,
      downstream: edge.downstream,
      kind: edge.kind,
    })),
    positions: snapshot.positions,
    tombstones: Object.keys(snapshot.tombstones),
    approvals: snapshot.approvals,
    policies: snapshot.policies,
    annotations: snapshot.annotations,
    handoffs: snapshot.handoffs,
    deviations: snapshot.deviations,
    workerLogs: snapshot.worker_logs,
    readySince: Object.fromEntries(
      Object.values(snapshot.nodes)
        .filter((node) => node.ready_since)
        .map((node) => [node.id, node.ready_since as string]),
    ),
  }
}

function eventChange(
  event: MissionEvent,
  nodes: TaskNode[],
  edges: GraphEdge[],
): DigestChange {
  const actor =
    event.actor === 'human'
      ? 'Human'
      : event.actor === 'browser_agent'
        ? 'Browser agent'
        : event.actor === 'supervisor'
          ? 'Supervisor'
          : `Worker ${event.actor.slice('worker:'.length)}`
  return {
    seq: event.seq,
    actor: event.actor,
    type: event.type,
    one_liner: `${actor}: ${describeEvent(event, nodes, edges)}`,
  }
}

export const useMissionStore = create<MissionState>((set, get) => ({
  ...initial,
  events: shortyEvents,
  changes: [],
  selectedId: null,
  highlightedIds: [],
  cameraRequest: null,
  toast: null,
  structuralPreview: null,
  readySince: shortyReadySince,
  projectId: null,
  cursor: '0',
  connectionMode: 'loading',
  connectionMessage: 'Connecting to the live project…',
  sessionId: '',
  clockSkewMs: 0,
  linkErrorHasStoredIdentity: false,
  hydratePositions(positions) {
    set((state) => ({ positions: { ...positions, ...state.positions } }))
  },
  applySnapshot(snapshot, cursor, projectId) {
    set((state) => {
      if (
        !shouldApplySnapshot(
          state.projectId,
          state.cursor,
          projectId,
          cursor,
        )
      ) {
        return state
      }
      const view = snapshotToView(snapshot)
      const projectChanged = state.projectId !== projectId
      const firstLiveSnapshot =
        projectChanged || state.connectionMode === 'fixture'
      const selectedExists =
        view.nodes.some((node) => node.id === state.selectedId) ||
        view.edges.some((edge) => edge.edge_id === state.selectedId)
      return {
        ...view,
        projectId,
        cursor,
        events: firstLiveSnapshot ? [] : state.events,
        changes: firstLiveSnapshot ? [] : state.changes,
        approvalRanking: projectChanged ? [] : state.approvalRanking,
        approvalRankingSource: projectChanged
          ? ('pending' as const)
          : state.approvalRankingSource,
        approvalRankingStale: projectChanged
          ? false
          : state.approvalRankingStale,
        selectedId: selectedExists ? state.selectedId : null,
        connectionMode: 'live',
        connectionMessage: 'Live server',
        linkErrorHasStoredIdentity: false,
      }
    })
  },
  applyEvent(event) {
    const state = get()
    if (!eventBelongsToProject(state.projectId, event.project_id)) return
    if (event.seq !== Number(state.cursor) + 1) return

    const previousNodes = state.nodes
    const previousEdges = state.edges
    let nodes = previousNodes
    let edges = previousEdges
    let positions = state.positions
    let tombstones = state.tombstones
    let approvals = state.approvals
    let policies = state.policies
    let annotations = state.annotations
    let handoffs = state.handoffs
    let deviations = state.deviations
    let workerLogs = state.workerLogs
    let selectedId = state.selectedId
    let readySince = state.readySince

    switch (event.type) {
      case 'TASK_ADDED':
        nodes = [
          ...nodes,
          {
            ...event.payload.node,
            assigned: event.payload.node.state !== 'queued',
            ever_started: event.payload.node.state !== 'queued',
          } as TaskNode & { assigned: boolean; ever_started: boolean },
        ]
        break
      case 'TASK_REMOVED':
        nodes = nodes.filter((node) => node.id !== event.payload.node_id)
        edges = edges.filter(
          (edge) =>
            edge.upstream !== event.payload.node_id &&
            edge.downstream !== event.payload.node_id,
        )
        tombstones = [...tombstones, event.payload.node_id]
        if (selectedId === event.payload.node_id) selectedId = null
        break
      case 'EDGE_ADDED':
        edges = [...edges, event.payload]
        break
      case 'EDGE_REMOVED':
        edges = edges.filter((edge) => edge.edge_id !== event.payload.edge_id)
        if (selectedId === event.payload.edge_id) selectedId = null
        break
      case 'DISPATCHED':
        nodes = nodes.map((node) =>
          node.id === event.payload.node_id ? { ...node, assigned: true } : node,
        )
        readySince = Object.fromEntries(
          Object.entries(readySince).filter(([id]) => id !== event.payload.node_id),
        )
        break
      case 'APPROVED':
        nodes = nodes.map((node) =>
          node.id === event.payload.node_id ? { ...node, state: 'done' } : node,
        )
        approvals = {
          ...approvals,
          [event.payload.approval_id]: {
            ...approvals[event.payload.approval_id],
            status: 'approved',
            resolved_at: event.ts,
            policy_ref: event.payload.policy_ref,
            rationale: event.payload.rationale,
          },
        }
        break
      case 'REJECTED':
        nodes = nodes.map((node) =>
          node.id === event.payload.node_id ? { ...node, state: 'running' } : node,
        )
        approvals = {
          ...approvals,
          [event.payload.approval_id]: {
            ...approvals[event.payload.approval_id],
            status: 'rejected',
            resolved_at: event.ts,
            policy_ref: event.payload.policy_ref,
            reason: event.payload.reason,
          },
        }
        break
      case 'POLICY_STATED':
        policies = {
          ...policies,
          [event.payload.policy_ref]: {
            text: event.payload.text,
            session_id: event.payload.session_id,
            stated_at: event.ts,
          },
        }
        break
      case 'ANNOTATED':
        annotations = {
          ...annotations,
          [event.payload.target_id]: [
            ...(annotations[event.payload.target_id] ?? []),
            { actor: event.actor, note: event.payload.note, ts: event.ts },
          ],
        }
        break
      case 'NODE_STATE_CHANGED':
        nodes = nodes.map((node) =>
          node.id === event.payload.node_id
            ? {
                ...node,
                state: event.payload.to,
                assigned:
                  (node as TaskNode & { assigned?: boolean }).assigned ||
                  event.payload.to !== 'queued',
                ever_started:
                  (node as TaskNode & { ever_started?: boolean }).ever_started ||
                  ['running', 'review', 'done', 'failed'].includes(
                    event.payload.to,
                  ),
              }
            : node,
        )
        break
      case 'PAUSE_ACKED':
        nodes = nodes.map((node) =>
          node.id === event.payload.node_id ? { ...node, state: 'paused' } : node,
        )
        break
      case 'WORKER_LOG':
        workerLogs = {
          ...workerLogs,
          [event.payload.node_id]: [
            ...(workerLogs[event.payload.node_id] ?? []),
            ...event.payload.lines,
          ].slice(-200),
        }
        break
      case 'HANDOFF_FILED':
        nodes = nodes.map((node) =>
          node.id === event.payload.node_id ? { ...node, state: 'review' } : node,
        )
        handoffs = { ...handoffs, [event.payload.node_id]: event.payload.handoff }
        break
      case 'DEVIATION_NOTED':
        deviations = {
          ...deviations,
          [event.payload.node_id]: [
            ...(deviations[event.payload.node_id] ?? []),
            { ...event.payload, ts: event.ts },
          ],
        }
        break
      case 'APPROVAL_CREATED':
        approvals = {
          ...approvals,
          [event.payload.approval_id]: {
            id: event.payload.approval_id,
            node_id: event.payload.node_id,
            summary: event.payload.summary,
            created_at: event.ts,
            created_seq: event.seq,
            status: 'pending',
            diff_stats: event.payload.diff_stats,
            tests: event.payload.tests,
          },
        }
        break
      case 'NODE_MOVED':
        positions = {
          ...positions,
          [event.payload.node_id]: { x: event.payload.x, y: event.payload.y },
        }
        break
      case 'SELECTION_CHANGED':
        if (event.payload.client_id === state.sessionId) {
          selectedId = event.payload.selected[0] ?? null
        }
        break
    }

    readySince = refreshReadySince(
      previousNodes,
      previousEdges,
      nodes,
      edges,
      readySince,
      event.ts,
    )

    const change = eventChange(event, nodes, edges)
    const approvalRanking =
      state.connectionMode === 'fixture'
        ? fixtureRankedPendingApprovals(approvals, nodes, edges).map((approval) => ({
            approval_id: approval.id,
            node_id: approval.node_id,
            node_title:
              nodes.find((node) => node.id === approval.node_id)?.title ??
              approval.node_id,
            summary: approval.summary,
            delay_impact_min: approval.delayImpactMin,
            age_since: approval.created_at,
          }))
        : state.approvalRanking
    set({
      nodes,
      edges,
      positions,
      tombstones,
      approvals,
      approvalRanking,
      policies,
      annotations,
      handoffs,
      deviations,
      workerLogs,
      selectedId,
      readySince,
      cursor: String(event.seq),
      events: boundedHistory([
        ...state.events.filter((item) => item.seq !== event.seq),
        event,
      ]),
      changes: boundedHistory([
        ...state.changes.filter((item) => item.seq !== event.seq),
        change,
      ]),
    })
    if (event.actor === 'browser_agent') {
      get().showToast(`🤖 via your agent — ${describeEvent(event, nodes, edges)}`)
    }
  },
  recordHistoricalEvent(event) {
    const state = get()
    if (!eventBelongsToProject(state.projectId, event.project_id)) return
    if (event.seq > Number(state.cursor)) {
      state.applyEvent(event)
      return
    }
    const change = eventChange(event, state.nodes, state.edges)
    set({
      events: boundedHistory([
        ...state.events.filter((item) => item.seq !== event.seq),
        event,
      ]),
      changes: boundedHistory([
        ...state.changes.filter((item) => item.seq !== event.seq),
        change,
      ]),
    })
  },
  applyDigestChanges(projectId, changes, cursor) {
    set((state) =>
      !shouldApplyDigest(state.projectId, state.cursor, projectId, cursor)
        ? state
        : {
            changes: boundedHistory(
              [...state.changes, ...changes].filter(
                (change, index, all) =>
                  all.findIndex((candidate) => candidate.seq === change.seq) ===
                  index,
              ),
            ),
            cursor,
          },
    )
  },
  applyServerDigest(projectId, digest) {
    set((state) => {
      if (
        state.projectId !== projectId ||
        !shouldApplySnapshot(
          state.projectId,
          state.cursor,
          projectId,
          digest.cursor,
        )
      ) {
        return state
      }
      return {
        approvalRanking: digest.summary.pending_approvals,
        approvalRankingSource: 'server',
        approvalRankingStale: false,
      }
    })
  },
  markApprovalRankingStale(projectId) {
    set((state) =>
      state.projectId === projectId
        ? { approvalRankingStale: true }
        : state,
    )
  },
  useFixture(message) {
    set({
      ...fixtureState(),
      events: shortyEvents,
      changes: [],
      readySince: shortyReadySince,
      projectId: 'shorty-demo',
      cursor: String(shortyEvents.at(-1)?.seq ?? 0),
      connectionMode: 'fixture',
      connectionMessage: message,
      clockSkewMs: 0,
      linkErrorHasStoredIdentity: false,
    })
  },
  setConnectionMode(connectionMode, connectionMessage) {
    set({
      connectionMode,
      connectionMessage,
      ...(connectionMode === 'link-error'
        ? {}
        : { linkErrorHasStoredIdentity: false }),
    })
  },
  setClockSkew(clockSkewMs) {
    set({ clockSkewMs })
  },
  showInvalidMissionLink(linkErrorHasStoredIdentity) {
    set({
      connectionMode: 'link-error',
      connectionMessage: 'Expired or invalid mission link',
      linkErrorHasStoredIdentity,
    })
  },
  setSessionId(sessionId) {
    set({ sessionId })
  },
  moveNode(nodeId, point) {
    set((state) => ({ positions: { ...state.positions, [nodeId]: point } }))
    void sendMutation(
      'NODE_MOVED',
      { node_id: nodeId, x: point.x, y: point.y },
      { debounceKey: `move:${nodeId}` },
    ).catch((error: unknown) => reportMutationError(error, get()))
  },
  connectNodes(upstream, downstream) {
    const state = get()
    if (wouldCreateCycle(state.edges, upstream, downstream)) {
      state.showToast(
        'Dependency rejected: that connection would create a cycle.',
        'error',
      )
      return false
    }
    if (
      state.edges.some(
        (edge) =>
          edge.kind === 'depends' &&
          edge.upstream === upstream &&
          edge.downstream === downstream,
      )
    ) {
      state.showToast('That dependency already exists.', 'error')
      return false
    }
    const payload = {
      edge_id: crypto.randomUUID(),
      upstream,
      downstream,
      kind: 'depends',
    } as const
    const apply = prepareStoreMutation('EDGE_ADDED', payload)
    const touched = state.nodes.filter(
      (node) => node.id === upstream || node.id === downstream,
    )
    if (touched.some(isNonIdle)) {
      const ids = [upstream, downstream]
      pendingStructuralOperation = {
        title: 'Add dependency',
        ids,
        baseCursor: state.cursor,
        apply,
      }
      set({
        structuralPreview: {
          title: 'Add dependency',
          baseCursor: state.cursor,
          blastRadius: getBlastRadius(ids, state.nodes, state.edges),
        },
      })
      return true
    }
    void apply().catch((error: unknown) => reportMutationError(error, get()))
    return true
  },
  removeSelected() {
    const state = get()
    if (!state.selectedId) return
    const node = state.nodes.find((candidate) => candidate.id === state.selectedId)
    const edge = state.edges.find(
      (candidate) => candidate.edge_id === state.selectedId,
    )
    const apply = node
      ? prepareStoreMutation('TASK_REMOVED', {
          node_id: node.id,
          tombstone: true,
        })
      : edge
        ? prepareStoreMutation('EDGE_REMOVED', { edge_id: edge.edge_id })
        : null
    if (!apply) return
    const ids = node ? [node.id] : [edge!.upstream, edge!.downstream]
    const needsPreview = node
      ? isNonIdle(node) ||
        state.edges.some(
          (candidate) =>
            candidate.upstream === node.id || candidate.downstream === node.id,
        )
      : ids.some((id) => {
          const touched = state.nodes.find((candidate) => candidate.id === id)
          return touched ? isNonIdle(touched) : false
        })
    if (needsPreview) {
      const title = node ? `Remove ${node.title}` : 'Remove relationship'
      pendingStructuralOperation = {
        title,
        ids,
        baseCursor: state.cursor,
        apply,
      }
      set({
        structuralPreview: {
          title,
          baseCursor: state.cursor,
          blastRadius: getBlastRadius(ids, state.nodes, state.edges),
        },
      })
      return
    }
    void apply().catch((error: unknown) => reportMutationError(error, get()))
  },
  confirmStructural() {
    const pending = pendingStructuralOperation
    if (!pending) return
    const state = get()
    if (isPreviewStale(pending.baseCursor, state.cursor)) {
      pending.baseCursor = state.cursor
      set({
        structuralPreview: {
          title: pending.title,
          baseCursor: state.cursor,
          blastRadius: getBlastRadius(pending.ids, state.nodes, state.edges),
        },
      })
      state.showToast(
        'The graph changed. Review the refreshed blast radius before confirming again.',
        'error',
      )
      return
    }
    pendingStructuralOperation = null
    set({ structuralPreview: null })
    void pending.apply().catch((error: unknown) =>
      reportMutationError(error, get()),
    )
  },
  cancelStructural() {
    pendingStructuralOperation = null
    set({ structuralPreview: null })
  },
  select(id) {
    set({ selectedId: id })
    const sessionId = get().sessionId
    if (!sessionId) return
    void sendMutation('SELECTION_CHANGED', {
      client_id: sessionId,
      selected: id ? [id] : [],
    }).catch((error: unknown) => reportMutationError(error, get()))
  },
  approve(nodeId, policyRef) {
    const approval = Object.values(get().approvals).find(
      (item) => item.node_id === nodeId && item.status === 'pending',
    )
    if (!approval) return
    void sendMutation('APPROVED', {
      approval_id: approval.id,
      node_id: nodeId,
      rationale: 'Approved from the MissionGraph dossier after review.',
      ...(policyRef ? { policy_ref: policyRef } : {}),
    }).catch((error: unknown) => reportMutationError(error, get()))
  },
  reject(nodeId, policyRef) {
    const approval = Object.values(get().approvals).find(
      (item) => item.node_id === nodeId && item.status === 'pending',
    )
    if (!approval) return
    void sendMutation('REJECTED', {
      approval_id: approval.id,
      node_id: nodeId,
      reason: 'Returned from the MissionGraph dossier for another pass.',
      ...(policyRef ? { policy_ref: policyRef } : {}),
    }).catch((error: unknown) => reportMutationError(error, get()))
  },
  dispatch(nodeId) {
    void sendMutation('DISPATCHED', {
      node_id: nodeId,
      bypass_cap: true,
    }).catch((error: unknown) => reportMutationError(error, get()))
  },
  setHighlights(highlightedIds) {
    set({ highlightedIds })
  },
  requestCamera(nodeIds) {
    set({ cameraRequest: { id: crypto.randomUUID(), nodeIds } })
  },
  showToast(message, tone = 'info', caption) {
    set({
      toast: {
        id: crypto.randomUUID(),
        message,
        tone,
        ...(caption ? { caption } : {}),
      },
    })
  },
  clearToast() {
    set({ toast: null })
  },
}))

export function currentCriticalPath() {
  const state = useMissionStore.getState()
  return getCriticalPath(state.nodes, state.edges)
}
