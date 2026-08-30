import { create } from 'zustand'
import {
  shortyApprovals,
  shortyEvents,
  shortyReadySince,
} from '../fixtures/shorty-dag'
import { describeEvent, getCriticalPath, wouldCreateCycle } from '../model/graph'
import type {
  Approval,
  DigestChange,
  EventPayloadMap,
  EvType,
  GraphEdge,
  GraphSnapshotState,
  Handoff,
  MissionEvent,
  TaskNode,
} from '../model/types'

interface Point {
  x: number
  y: number
}

interface Toast {
  id: string
  tone: 'info' | 'error'
  message: string
}

export interface CameraRequest {
  id: string
  nodeIds: string[]
}

export type ConnectionMode = 'loading' | 'live' | 'fixture'

export interface MutationOptions {
  actor?: 'human' | 'browser_agent'
  debounceKey?: string
}

export type MutationSender = <T extends EvType>(
  type: T,
  payload: EventPayloadMap[T],
  options?: MutationOptions,
) => Promise<number>

interface MissionState {
  nodes: TaskNode[]
  edges: GraphEdge[]
  events: MissionEvent[]
  changes: DigestChange[]
  positions: Record<string, Point>
  tombstones: string[]
  approvals: Record<string, Approval>
  annotations: GraphSnapshotState['annotations']
  handoffs: Record<string, Handoff>
  deviations: GraphSnapshotState['deviations']
  workerLogs: Record<string, string[]>
  selectedId: string | null
  highlightedIds: string[]
  cameraRequest: CameraRequest | null
  toast: Toast | null
  readySince: Record<string, string>
  projectId: string | null
  cursor: string
  connectionMode: ConnectionMode
  connectionMessage: string
  sessionId: string
  hydratePositions: (positions: Record<string, Point>) => void
  applySnapshot: (
    snapshot: GraphSnapshotState,
    cursor: string,
    projectId: string,
  ) => void
  applyEvent: (event: MissionEvent) => void
  applyDigestChanges: (changes: DigestChange[], cursor: string) => void
  useFixture: (message: string) => void
  setConnectionMode: (mode: ConnectionMode, message: string) => void
  setSessionId: (sessionId: string) => void
  moveNode: (nodeId: string, point: Point) => void
  connectNodes: (upstream: string, downstream: string) => boolean
  removeSelected: () => void
  select: (id: string | null) => void
  approve: (nodeId: string) => void
  reject: (nodeId: string) => void
  dispatch: (nodeId: string) => void
  setHighlights: (ids: string[]) => void
  requestCamera: (ids: string[]) => void
  showToast: (message: string, tone?: Toast['tone']) => void
  clearToast: () => void
}

let mutationSender: MutationSender | null = null

export function configureMutationSender(sender: MutationSender) {
  mutationSender = sender
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

function fixtureState() {
  const nodeById = new Map<string, TaskNode>()
  const edgeById = new Map<string, GraphEdge>()
  const positions: Record<string, Point> = {}
  const tombstones: string[] = []
  const handoffs: Record<string, Handoff> = {}
  const deviations: GraphSnapshotState['deviations'] = {}
  const workerLogs: Record<string, string[]> = {}
  const annotations: GraphSnapshotState['annotations'] = {}

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

  return {
    nodes: [...nodeById.values()],
    edges: [...edgeById.values()],
    positions,
    tombstones,
    approvals,
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
  readySince: shortyReadySince,
  projectId: null,
  cursor: '0',
  connectionMode: 'loading',
  connectionMessage: 'Connecting to the live project…',
  sessionId: '',
  hydratePositions(positions) {
    set((state) => ({ positions: { ...positions, ...state.positions } }))
  },
  applySnapshot(snapshot, cursor, projectId) {
    set((state) => {
      const view = snapshotToView(snapshot)
      const firstLiveSnapshot = state.connectionMode === 'loading'
      const selectedExists =
        view.nodes.some((node) => node.id === state.selectedId) ||
        view.edges.some((edge) => edge.edge_id === state.selectedId)
      return {
        ...view,
        projectId,
        cursor,
        events: firstLiveSnapshot ? [] : state.events,
        changes: firstLiveSnapshot ? [] : state.changes,
        selectedId: selectedExists ? state.selectedId : null,
        connectionMode: 'live',
        connectionMessage: 'Live server',
      }
    })
  },
  applyEvent(event) {
    const state = get()
    if (event.seq <= Number(state.cursor)) return

    let nodes = state.nodes
    let edges = state.edges
    let positions = state.positions
    let tombstones = state.tombstones
    let approvals = state.approvals
    let annotations = state.annotations
    let handoffs = state.handoffs
    let deviations = state.deviations
    let workerLogs = state.workerLogs
    let selectedId = state.selectedId
    let readySince = state.readySince

    switch (event.type) {
      case 'TASK_ADDED':
        nodes = [...nodes, event.payload.node]
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
            ? { ...node, state: event.payload.to }
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

    const change = eventChange(event, nodes, edges)
    set({
      nodes,
      edges,
      positions,
      tombstones,
      approvals,
      annotations,
      handoffs,
      deviations,
      workerLogs,
      selectedId,
      readySince,
      cursor: String(event.seq),
      events: [...state.events.filter((item) => item.seq !== event.seq), event]
        .sort((left, right) => left.seq - right.seq)
        .slice(-250),
      changes: [...state.changes.filter((item) => item.seq !== event.seq), change]
        .sort((left, right) => left.seq - right.seq)
        .slice(-250),
    })
    if (event.actor === 'browser_agent') {
      get().showToast(`🤖 via your agent — ${describeEvent(event, nodes, edges)}`)
    }
  },
  applyDigestChanges(changes, cursor) {
    set((state) => ({
      changes: [...state.changes, ...changes]
        .filter(
          (change, index, all) =>
            all.findIndex((candidate) => candidate.seq === change.seq) === index,
        )
        .sort((left, right) => left.seq - right.seq)
        .slice(-250),
      cursor,
    }))
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
    })
  },
  setConnectionMode(connectionMode, connectionMessage) {
    set({ connectionMode, connectionMessage })
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
    ).catch((error: unknown) =>
      get().showToast(error instanceof Error ? error.message : String(error), 'error'),
    )
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
    void sendMutation('EDGE_ADDED', {
      edge_id: crypto.randomUUID(),
      upstream,
      downstream,
      kind: 'depends',
    }).catch((error: unknown) =>
      get().showToast(error instanceof Error ? error.message : String(error), 'error'),
    )
    return true
  },
  removeSelected() {
    const state = get()
    if (!state.selectedId) return
    const node = state.nodes.find((candidate) => candidate.id === state.selectedId)
    const edge = state.edges.find(
      (candidate) => candidate.edge_id === state.selectedId,
    )
    const mutation = node
      ? sendMutation('TASK_REMOVED', { node_id: node.id, tombstone: true })
      : edge
        ? sendMutation('EDGE_REMOVED', { edge_id: edge.edge_id })
        : null
    void mutation?.catch((error: unknown) =>
      get().showToast(error instanceof Error ? error.message : String(error), 'error'),
    )
  },
  select(id) {
    set({ selectedId: id })
    const sessionId = get().sessionId
    if (!sessionId) return
    void sendMutation('SELECTION_CHANGED', {
      client_id: sessionId,
      selected: id ? [id] : [],
    }).catch((error: unknown) =>
      get().showToast(error instanceof Error ? error.message : String(error), 'error'),
    )
  },
  approve(nodeId) {
    const approval = Object.values(get().approvals).find(
      (item) => item.node_id === nodeId && item.status === 'pending',
    )
    if (!approval) return
    void sendMutation('APPROVED', {
      approval_id: approval.id,
      node_id: nodeId,
      rationale: 'Approved from the MissionGraph dossier after review.',
    }).catch((error: unknown) =>
      get().showToast(error instanceof Error ? error.message : String(error), 'error'),
    )
  },
  reject(nodeId) {
    const approval = Object.values(get().approvals).find(
      (item) => item.node_id === nodeId && item.status === 'pending',
    )
    if (!approval) return
    void sendMutation('REJECTED', {
      approval_id: approval.id,
      node_id: nodeId,
      reason: 'Returned from the MissionGraph dossier for another pass.',
    }).catch((error: unknown) =>
      get().showToast(error instanceof Error ? error.message : String(error), 'error'),
    )
  },
  dispatch(nodeId) {
    void sendMutation('DISPATCHED', {
      node_id: nodeId,
      bypass_cap: true,
    }).catch((error: unknown) =>
      get().showToast(error instanceof Error ? error.message : String(error), 'error'),
    )
  },
  setHighlights(highlightedIds) {
    set({ highlightedIds })
  },
  requestCamera(nodeIds) {
    set({ cameraRequest: { id: crypto.randomUUID(), nodeIds } })
  },
  showToast(message, tone = 'info') {
    set({ toast: { id: crypto.randomUUID(), message, tone } })
  },
  clearToast() {
    set({ toast: null })
  },
}))

export function currentCriticalPath() {
  const state = useMissionStore.getState()
  return getCriticalPath(state.nodes, state.edges)
}
