import { create } from 'zustand'
import {
  shortyApprovals,
  shortyEvents,
  shortyReadySince,
} from '../fixtures/shorty-dag'
import { wouldCreateCycle } from '../model/graph'
import type {
  Actor,
  EventPayloadMap,
  EvType,
  GraphEdge,
  MissionEvent,
  NodeState,
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

interface MissionState {
  nodes: TaskNode[]
  edges: GraphEdge[]
  events: MissionEvent[]
  positions: Record<string, Point>
  tombstones: string[]
  selectedId: string | null
  highlightedIds: string[]
  toast: Toast | null
  readySince: Record<string, string>
  hydratePositions: (positions: Record<string, Point>) => void
  moveNode: (nodeId: string, point: Point) => void
  connectNodes: (upstream: string, downstream: string) => boolean
  removeSelected: () => void
  select: (id: string | null) => void
  approve: (nodeId: string) => void
  reject: (nodeId: string) => void
  dispatch: (nodeId: string) => void
  setHighlights: (ids: string[]) => void
  showToast: (message: string, tone?: Toast['tone']) => void
  clearToast: () => void
}

function foldEvents(events: MissionEvent[]) {
  const nodeById = new Map<string, TaskNode>()
  const edgeById = new Map<string, GraphEdge>()
  const positions: Record<string, Point> = {}
  const tombstones: string[] = []

  for (const event of events) {
    switch (event.type) {
      case 'TASK_ADDED':
        nodeById.set(event.payload.node.id, event.payload.node)
        break
      case 'TASK_REMOVED':
        nodeById.delete(event.payload.node_id)
        tombstones.push(event.payload.node_id)
        for (const edge of edgeById.values()) {
          if (
            edge.upstream === event.payload.node_id ||
            edge.downstream === event.payload.node_id
          ) {
            edgeById.delete(edge.edge_id)
          }
        }
        break
      case 'EDGE_ADDED':
        edgeById.set(event.payload.edge_id, event.payload)
        break
      case 'EDGE_REMOVED':
        edgeById.delete(event.payload.edge_id)
        break
      case 'NODE_STATE_CHANGED': {
        const node = nodeById.get(event.payload.node_id)
        if (node) {
          nodeById.set(node.id, { ...node, state: event.payload.to })
        }
        break
      }
      case 'APPROVED': {
        const node = nodeById.get(event.payload.node_id)
        if (node) {
          nodeById.set(node.id, { ...node, state: 'done' })
        }
        break
      }
      case 'REJECTED': {
        const node = nodeById.get(event.payload.node_id)
        if (node) {
          nodeById.set(node.id, { ...node, state: 'running' })
        }
        break
      }
      case 'NODE_MOVED':
        positions[event.payload.node_id] = {
          x: event.payload.x,
          y: event.payload.y,
        }
        break
    }
  }

  return {
    nodes: [...nodeById.values()],
    edges: [...edgeById.values()],
    positions,
    tombstones,
  }
}

function makeEvent<T extends EvType>(
  events: MissionEvent[],
  type: T,
  payload: EventPayloadMap[T],
  actor: Actor = 'human',
): MissionEvent {
  const seq = (events.at(-1)?.seq ?? 0) + 1

  return {
    seq,
    project_id: 'shorty-demo',
    ts: new Date().toISOString(),
    actor,
    type,
    payload,
    idem_key: crypto.randomUUID(),
  } as MissionEvent
}

const initial = foldEvents(shortyEvents)

export const useMissionStore = create<MissionState>((set, get) => ({
  ...initial,
  events: shortyEvents,
  selectedId: null,
  highlightedIds: [],
  toast: null,
  readySince: shortyReadySince,
  hydratePositions(positions) {
    set((state) => ({ positions: { ...positions, ...state.positions } }))
  },
  moveNode(nodeId, point) {
    set((state) => ({
      positions: { ...state.positions, [nodeId]: point },
      events: [
        ...state.events,
        makeEvent(state.events, 'NODE_MOVED', {
          node_id: nodeId,
          x: point.x,
          y: point.y,
        }),
      ],
    }))
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

    const edge: GraphEdge = {
      edge_id: `depends-${upstream}-${downstream}-${Date.now()}`,
      upstream,
      downstream,
      kind: 'depends',
    }
    set((current) => ({
      edges: [...current.edges, edge],
      events: [
        ...current.events,
        makeEvent(current.events, 'EDGE_ADDED', edge),
      ],
    }))
    state.showToast('Dependency added to the mission graph.')
    return true
  },
  removeSelected() {
    const state = get()
    if (!state.selectedId) {
      return
    }

    const node = state.nodes.find((candidate) => candidate.id === state.selectedId)
    if (node) {
      const event = makeEvent(state.events, 'TASK_REMOVED', {
        node_id: node.id,
        tombstone: true,
      })
      set((current) => ({
        nodes: current.nodes.filter((candidate) => candidate.id !== node.id),
        edges: current.edges.filter(
          (edge) => edge.upstream !== node.id && edge.downstream !== node.id,
        ),
        tombstones: [...current.tombstones, node.id],
        selectedId: null,
        events: [...current.events, event],
      }))
      state.showToast(`${node.title} was tombstoned and removed from the canvas.`)
      return
    }

    const edge = state.edges.find(
      (candidate) => candidate.edge_id === state.selectedId,
    )
    if (edge) {
      set((current) => ({
        edges: current.edges.filter(
          (candidate) => candidate.edge_id !== edge.edge_id,
        ),
        selectedId: null,
        events: [
          ...current.events,
          makeEvent(current.events, 'EDGE_REMOVED', { edge_id: edge.edge_id }),
        ],
      }))
      state.showToast('Relationship removed from the canvas.')
    }
  },
  select(id) {
    set((state) => ({
      selectedId: id,
      events: [
        ...state.events,
        makeEvent(state.events, 'SELECTION_CHANGED', {
          client_id: 'fixture-browser',
          selected: id ? [id] : [],
        }),
      ],
    }))
  },
  approve(nodeId) {
    const state = get()
    const approval = shortyApprovals.find((item) => item.node_id === nodeId)
    const node = state.nodes.find((item) => item.id === nodeId)
    if (!approval || !node || node.state !== 'review') {
      return
    }
    const event = makeEvent(state.events, 'APPROVED', {
      approval_id: approval.id,
      node_id: nodeId,
      rationale: 'Approved from the local fixture dossier after review.',
    })
    set((current) => ({
      nodes: current.nodes.map((item) =>
        item.id === nodeId ? { ...item, state: 'done' as NodeState } : item,
      ),
      events: [...current.events, event],
    }))
    state.showToast(`${node.title} approved locally.`)
  },
  reject(nodeId) {
    const state = get()
    const approval = shortyApprovals.find((item) => item.node_id === nodeId)
    const node = state.nodes.find((item) => item.id === nodeId)
    if (!approval || !node || node.state !== 'review') {
      return
    }
    const event = makeEvent(state.events, 'REJECTED', {
      approval_id: approval.id,
      node_id: nodeId,
      reason: 'Returned from the local fixture dossier for another pass.',
    })
    set((current) => ({
      nodes: current.nodes.map((item) =>
        item.id === nodeId ? { ...item, state: 'running' as NodeState } : item,
      ),
      events: [...current.events, event],
    }))
    state.showToast(`${node.title} returned to its fixture worker.`)
  },
  dispatch(nodeId) {
    const state = get()
    const node = state.nodes.find((item) => item.id === nodeId)
    if (!node || node.state !== 'queued') {
      return
    }
    const dispatched = makeEvent(state.events, 'DISPATCHED', {
      node_id: nodeId,
      bypass_cap: true,
    })
    const started = makeEvent(
      [...state.events, dispatched],
      'NODE_STATE_CHANGED',
      {
        node_id: nodeId,
        from: node.state,
        to: 'running',
        detail: 'The local fixture worker accepted the dispatch.',
      },
      'supervisor',
    )
    set((current) => ({
      nodes: current.nodes.map((item) =>
        item.id === nodeId ? { ...item, state: 'running' as NodeState } : item,
      ),
      events: [...current.events, dispatched, started],
    }))
    state.showToast(`${node.title} dispatched in the local fixture.`)
  },
  setHighlights(ids) {
    set({ highlightedIds: ids })
  },
  showToast(message, tone = 'info') {
    set({ toast: { id: crypto.randomUUID(), message, tone } })
  },
  clearToast() {
    set({ toast: null })
  },
}))
