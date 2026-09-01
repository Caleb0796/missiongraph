import type {
  Approval,
  EventPayloadMap,
  GraphDigest,
  GraphEdge,
  MissionEvent,
  TaskNode,
} from './types'

export type DisplayState =
  | 'queued'
  | 'ready'
  | 'running'
  | 'review'
  | 'done'
  | 'failed'
  | 'paused'
  | 'blocked'

export interface CriticalPath {
  nodeIds: string[]
  edgeIds: string[]
  eta: number
}

export const IDLE_THRESHOLD_MS = 10 * 60_000

export function isSplitParent(node: TaskNode) {
  return (node as TaskNode & { record_type?: string }).record_type === 'group'
}

export function activeFailedNodes(nodes: TaskNode[]) {
  return nodes.filter(
    (node) => node.state === 'failed' && !isSplitParent(node),
  )
}

export type ContextualToolName =
  | 'dispatch_selected'
  | 'explain_selected'
  | 'annotate_selected'
  | 'split_selected'
  | 'review_failures'

export function contextualToolNamesForState(
  nodes: TaskNode[],
  edges: GraphEdge[],
  selectedId: string | null,
) {
  const selected = nodes.find(
    (node) => node.id === selectedId && !isSplitParent(node),
  )
  const selectedEdge = edges.some((edge) => edge.edge_id === selectedId)
  const names: ContextualToolName[] = []
  if (selected || selectedEdge) names.push('explain_selected')
  if (selected) {
    names.push('annotate_selected', 'split_selected')
    if (
      getDisplayState(selected, nodes, edges) === 'ready' &&
      !(selected as TaskNode & { assigned?: boolean }).assigned
    ) {
      names.push('dispatch_selected')
    }
  }
  if (activeFailedNodes(nodes).length > 0) names.push('review_failures')
  return names
}

export function foldTaskSplit(
  nodes: TaskNode[],
  edges: GraphEdge[],
  payload: EventPayloadMap['TASK_SPLIT'],
) {
  const incident = new Map(
    edges
      .filter(
        (edge) =>
          edge.upstream === payload.parent_id ||
          edge.downstream === payload.parent_id,
      )
      .map((edge) => [edge.edge_id, edge]),
  )
  const remapped = payload.edge_remap.flatMap(({ edge_id, new_target }) => {
    const edge = incident.get(edge_id)
    if (!edge) return []
    return [
      {
        ...edge,
        upstream:
          edge.upstream === payload.parent_id ? new_target : edge.upstream,
        downstream:
          edge.downstream === payload.parent_id ? new_target : edge.downstream,
      },
    ]
  })
  const remappedIds = new Set(payload.edge_remap.map((remap) => remap.edge_id))
  return {
    nodes: [
      ...nodes.map((node) =>
        node.id === payload.parent_id
          ? ({
              ...node,
              record_type: 'group',
              child_ids: payload.children.map((child) => child.id),
              availability: null,
              ready_since: null,
              assigned: true,
              pause_requested: false,
            } as TaskNode)
          : node,
      ),
      ...payload.children.map(
        (child) =>
          ({
            ...child,
            parent_id: payload.parent_id,
            record_type: 'task',
            child_ids: [],
            availability: null,
            ready_since: null,
            assigned: child.state !== 'queued',
            ever_started: child.state !== 'queued',
            pause_requested: false,
          }) as TaskNode,
      ),
    ],
    edges: [
      ...edges.filter(
        (edge) =>
          edge.upstream !== payload.parent_id &&
          edge.downstream !== payload.parent_id,
      ),
      ...remapped,
    ],
    removedEdgeIds: [...incident.keys()].filter(
      (edgeId) => !remappedIds.has(edgeId),
    ),
  }
}

export interface EdgeLineageEntry {
  parent_id: string
  seq: number
}

export type EdgeLineage = Record<string, EdgeLineageEntry>

function edgeParentId(edge: GraphEdge, nodes: TaskNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const upstreamParent = byId.get(edge.upstream)?.parent_id
  const downstreamParent = byId.get(edge.downstream)?.parent_id
  return upstreamParent === downstreamParent
    ? upstreamParent
    : upstreamParent ?? downstreamParent
}

export function pruneEdgeLineage(
  lineage: EdgeLineage,
  nodes: TaskNode[],
  edges: GraphEdge[],
  limit = 500,
) {
  const edgeIds = new Set(edges.map((edge) => edge.edge_id))
  const nodeIds = new Set(nodes.map((node) => node.id))
  return Object.fromEntries(
    Object.entries(lineage)
      .filter(
        ([edgeId, entry]) =>
          edgeIds.has(edgeId) && nodeIds.has(entry.parent_id),
      )
      .sort(
        ([leftId, left], [rightId, right]) =>
          left.seq - right.seq || leftId.localeCompare(rightId),
      )
      .slice(-limit),
  )
}

export function foldEdgeLineage(
  current: EdgeLineage,
  event: MissionEvent,
  nodes: TaskNode[],
  edges: GraphEdge[],
) {
  const next = { ...current }
  if (event.type === 'TASK_SPLIT') {
    event.payload.edge_remap.forEach((remap) => {
      next[remap.edge_id] = {
        parent_id: event.payload.parent_id,
        seq: event.seq,
      }
    })
  }
  if (event.type === 'EDGE_ADDED') {
    const parentId = edgeParentId(event.payload, nodes)
    if (parentId) {
      next[event.payload.edge_id] = { parent_id: parentId, seq: event.seq }
    }
  }
  if (event.type === 'EDGE_REMOVED') delete next[event.payload.edge_id]
  return pruneEdgeLineage(next, nodes, edges)
}

export function getDisplayState(
  node: TaskNode,
  nodes: TaskNode[],
  edges: GraphEdge[],
): DisplayState {
  if (node.state !== 'queued') {
    return node.state
  }

  const nodeById = new Map(nodes.map((candidate) => [candidate.id, candidate]))
  const prerequisites = edges
    .filter((edge) => edge.kind === 'depends' && edge.downstream === node.id)
    .map((edge) => nodeById.get(edge.upstream))
    .filter((candidate): candidate is TaskNode => Boolean(candidate))

  return prerequisites.every((candidate) => candidate.state === 'done')
    ? 'ready'
    : 'blocked'
}

export function getCriticalPath(
  nodes: TaskNode[],
  edges: GraphEdge[],
): CriticalPath {
  const activeNodes = nodes.filter((node) => !isSplitParent(node))
  const nodeById = new Map(activeNodes.map((node) => [node.id, node]))
  const outgoing = new Map<string, GraphEdge[]>()

  for (const edge of edges) {
    if (edge.kind !== 'depends') {
      continue
    }

    const current = outgoing.get(edge.upstream) ?? []
    current.push(edge)
    current.sort((left, right) => left.downstream.localeCompare(right.downstream))
    outgoing.set(edge.upstream, current)
  }

  const memo = new Map<string, { eta: number; path: string[] }>()

  function longestFrom(nodeId: string): { eta: number; path: string[] } {
    const cached = memo.get(nodeId)
    if (cached) {
      return cached
    }

    const node = nodeById.get(nodeId)
    if (!node) {
      return { eta: 0, path: [] }
    }

    let bestTail = { eta: 0, path: [] as string[] }
    for (const edge of outgoing.get(nodeId) ?? []) {
      const candidate = longestFrom(edge.downstream)
      const candidateKey = candidate.path.join('/')
      const bestKey = bestTail.path.join('/')
      if (
        candidate.eta > bestTail.eta ||
        (candidate.eta === bestTail.eta && candidateKey < bestKey)
      ) {
        bestTail = candidate
      }
    }

    const result = {
      eta: (node.state === 'done' ? 0 : node.estimate_min) + bestTail.eta,
      path: [nodeId, ...bestTail.path],
    }
    memo.set(nodeId, result)
    return result
  }

  let best = { eta: 0, path: [] as string[] }
  for (const node of [...activeNodes].sort((left, right) => left.id.localeCompare(right.id))) {
    const candidate = longestFrom(node.id)
    const candidateKey = candidate.path.join('/')
    const bestKey = best.path.join('/')
    if (
      candidate.eta > best.eta ||
      (candidate.eta === best.eta && candidateKey < bestKey)
    ) {
      best = candidate
    }
  }

  const edgeIds = best.path.slice(1).flatMap((downstream, index) => {
    const upstream = best.path[index]
    const edge = edges.find(
      (candidate) =>
        candidate.kind === 'depends' &&
        candidate.upstream === upstream &&
        candidate.downstream === downstream,
    )
    return edge ? [edge.edge_id] : []
  })

  return { nodeIds: best.path, edgeIds, eta: best.eta }
}

export function wouldCreateCycle(
  edges: GraphEdge[],
  upstream: string,
  downstream: string,
) {
  if (upstream === downstream) {
    return true
  }

  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.kind === 'depends') {
      outgoing.set(edge.upstream, [
        ...(outgoing.get(edge.upstream) ?? []),
        edge.downstream,
      ])
    }
  }

  const pending = [downstream]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current === upstream) {
      return true
    }
    if (visited.has(current)) {
      continue
    }
    visited.add(current)
    pending.push(...(outgoing.get(current) ?? []))
  }

  return false
}

export function isNonIdle(node: TaskNode) {
  return (
    (node as TaskNode & { ever_started?: boolean }).ever_started ??
    node.state !== 'queued'
  )
}

export function isPreviewStale(previewCursor: string, currentCursor: string) {
  return previewCursor !== currentCursor
}

export function getBlastRadius(
  ids: string[],
  nodes: TaskNode[],
  edges: GraphEdge[],
) {
  const reached = new Set(ids)
  const pending = [...ids]
  while (pending.length > 0) {
    const current = pending.shift()!
    for (const edge of edges) {
      if (
        edge.kind === 'depends' &&
        edge.upstream === current &&
        !reached.has(edge.downstream)
      ) {
        reached.add(edge.downstream)
        pending.push(edge.downstream)
      }
    }
  }
  const stale = [...reached].filter((id) => {
    const target = nodes.find((node) => node.id === id) as
      | (TaskNode & { assigned?: boolean; ever_started?: boolean })
      | undefined
    return Boolean(
      target &&
        (target.assigned || target.ever_started || target.state !== 'queued'),
    )
  })
  return {
    stale,
    pausing: stale.filter(
      (id) => nodes.find((node) => node.id === id)?.state === 'running',
    ),
  }
}

export function isReadyUnassigned(
  node: TaskNode,
  nodes: TaskNode[],
  edges: GraphEdge[],
) {
  return (
    getDisplayState(node, nodes, edges) === 'ready' &&
    !(node as TaskNode & { assigned?: boolean }).assigned
  )
}

export function refreshReadySince(
  previousNodes: TaskNode[],
  previousEdges: GraphEdge[],
  nodes: TaskNode[],
  edges: GraphEdge[],
  current: Record<string, string>,
  transitionTime: string,
) {
  const previousById = new Map(previousNodes.map((node) => [node.id, node]))
  const next = { ...current }
  for (const node of nodes) {
    const ready = isReadyUnassigned(node, nodes, edges)
    const previous = previousById.get(node.id)
    const wasReady = previous
      ? isReadyUnassigned(previous, previousNodes, previousEdges)
      : false
    if (ready && !wasReady) next[node.id] = transitionTime
    if (!ready) delete next[node.id]
  }
  for (const id of Object.keys(next)) {
    if (!nodes.some((node) => node.id === id)) delete next[id]
  }
  return next
}

export function approvalsForNode(
  approvals: Record<string, Approval>,
  nodeId: string,
) {
  return Object.values(approvals)
    .filter((approval) => approval.node_id === nodeId)
    .sort(
      (left, right) =>
        left.created_seq - right.created_seq ||
        left.created_at.localeCompare(right.created_at) ||
        left.id.localeCompare(right.id),
    )
}

export function remainingPathWeight(
  nodeId: string,
  nodes: TaskNode[],
  edges: GraphEdge[],
) {
  const byId = new Map(nodes.map((item) => [item.id, item]))
  const memo = new Map<string, number>()
  function visit(id: string): number {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    const current = byId.get(id)
    if (!current) return 0
    const tails = edges
      .filter((edge) => edge.kind === 'depends' && edge.upstream === id)
      .map((edge) => visit(edge.downstream))
    const result =
      (current.state === 'done' ? 0 : current.estimate_min) +
      Math.max(0, ...tails)
    memo.set(id, result)
    return result
  }
  return visit(nodeId)
}

export function fixtureRankedPendingApprovals(
  approvals: Record<string, Approval>,
  nodes: TaskNode[],
  edges: GraphEdge[],
) {
  return Object.values(approvals)
    .filter((approval) => approval.status === 'pending')
    .map((approval) => ({
      ...approval,
      delayImpactMin: remainingPathWeight(approval.node_id, nodes, edges),
    }))
    .sort(
      (left, right) =>
        right.delayImpactMin - left.delayImpactMin ||
        left.created_at.localeCompare(right.created_at) ||
        left.id.localeCompare(right.id),
    )
}

export function approvalQueueFromRanking(
  approvals: Record<string, Approval>,
  ranking: GraphDigest['summary']['pending_approvals'],
) {
  return ranking.flatMap((ranked) => {
    const approval = approvals[ranked.approval_id]
    if (!approval || approval.status !== 'pending') return []
    return [{ ...approval, delayImpactMin: ranked.delay_impact_min }]
  })
}

function idleElapsed(since: string, now: number) {
  const compactMinutes = /^(\d+)m$/.exec(since)
  if (compactMinutes) return Number(compactMinutes[1]) * 60_000
  const parsed = Date.parse(since)
  return Number.isNaN(parsed) ? 0 : Math.max(0, now - parsed)
}

export function humanizeIdleAge(since: string, now = Date.now()) {
  const elapsed = idleElapsed(since, now)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'idle <1m'
  if (minutes < 60) return `idle ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `idle ${hours}h`
  return `idle ${Math.floor(hours / 24)}d`
}

export function idleRadar(
  nodes: TaskNode[],
  edges: GraphEdge[],
  readySince: Record<string, string>,
  now = Date.now(),
  threshold = IDLE_THRESHOLD_MS,
) {
  return nodes
    .filter((node) => {
      const runtime = node as TaskNode & {
        assigned?: boolean
        ever_started?: boolean
      }
      const since = readySince[node.id]
      return (
        getDisplayState(node, nodes, edges) === 'ready' &&
        !runtime.assigned &&
        !runtime.ever_started &&
        Boolean(since) &&
        idleElapsed(since, now) >= threshold
      )
    })
    .sort(
      (left, right) =>
        idleElapsed(readySince[right.id], now) -
          idleElapsed(readySince[left.id], now) ||
        left.id.localeCompare(right.id),
    )
}

export function eventTargetsNode(event: MissionEvent, nodeId: string) {
  switch (event.type) {
    case 'TASK_ADDED':
      return event.payload.node.id === nodeId
    case 'TASK_REMOVED':
    case 'DISPATCHED':
    case 'RETRY_REQUESTED':
    case 'PAUSE_REQUESTED':
    case 'RESUME_REQUESTED':
    case 'APPROVED':
    case 'REJECTED':
    case 'NODE_STATE_CHANGED':
    case 'PAUSE_ACKED':
    case 'WORKER_LOG':
    case 'HANDOFF_FILED':
    case 'DEVIATION_NOTED':
    case 'APPROVAL_CREATED':
    case 'NODE_MOVED':
      return event.payload.node_id === nodeId
    case 'TASK_SPLIT':
      return event.payload.parent_id === nodeId
    case 'ANNOTATED':
      return event.payload.target_id === nodeId
    default:
      return false
  }
}

export function boundedHistory<T extends { seq: number }>(items: T[], limit = 200) {
  return [...items]
    .sort((left, right) => left.seq - right.seq)
    .slice(-limit)
}

export function getEventNodeId(event: MissionEvent, edges: GraphEdge[]) {
  switch (event.type) {
    case 'TASK_ADDED':
      return event.payload.node.id
    case 'TASK_REMOVED':
    case 'DISPATCHED':
    case 'RETRY_REQUESTED':
    case 'PAUSE_REQUESTED':
    case 'RESUME_REQUESTED':
    case 'NODE_STATE_CHANGED':
    case 'PAUSE_ACKED':
    case 'WORKER_LOG':
    case 'HANDOFF_FILED':
    case 'DEVIATION_NOTED':
    case 'APPROVAL_CREATED':
    case 'APPROVED':
    case 'REJECTED':
      return event.payload.node_id
    case 'TASK_SPLIT':
      return event.payload.parent_id
    case 'EDGE_ADDED':
      return event.payload.downstream
    case 'EDGE_REMOVED':
      return edges.find((edge) => edge.edge_id === event.payload.edge_id)?.downstream
    case 'ANNOTATED': {
      const edge = edges.find((candidate) => candidate.edge_id === event.payload.target_id)
      return edge?.downstream ?? event.payload.target_id
    }
    default:
      return undefined
  }
}

export function describeEvent(
  event: MissionEvent,
  nodes: TaskNode[],
  edges: GraphEdge[],
) {
  const title = (id: string) =>
    nodes.find((node) => node.id === id)?.title ?? 'A removed task'
  const edgeTitle = (id: string) => {
    const edge = edges.find((candidate) => candidate.edge_id === id)
    return edge
      ? `${title(edge.upstream)} to ${title(edge.downstream)}`
      : 'A removed relationship'
  }

  switch (event.type) {
    case 'TASK_ADDED':
      return `${event.payload.node.title} joined the mission.`
    case 'TASK_REMOVED':
      return `${title(event.payload.node_id)} was retired from the active graph.`
    case 'TASK_SPLIT':
      return `${title(event.payload.parent_id)} was divided into smaller missions.`
    case 'EDGE_ADDED':
      return event.payload.kind === 'depends'
        ? `${title(event.payload.downstream)} now waits for ${title(event.payload.upstream)}.`
        : `${title(event.payload.upstream)} and ${title(event.payload.downstream)} share a likely file conflict.`
    case 'EDGE_REMOVED':
      return `The ${edgeTitle(event.payload.edge_id)} relationship was removed.`
    case 'DISPATCHED':
      return `${title(event.payload.node_id)} was dispatched to a worker.`
    case 'RETRY_REQUESTED':
      return `${title(event.payload.node_id)} received new retry guidance.`
    case 'PAUSE_REQUESTED':
      return `${title(event.payload.node_id)} was asked to pause safely.`
    case 'RESUME_REQUESTED':
      return `${title(event.payload.node_id)} was asked to resume.`
    case 'APPROVED':
      return `${title(event.payload.node_id)} was approved for completion.`
    case 'REJECTED':
      return `${title(event.payload.node_id)} returned to its worker with review guidance.`
    case 'POLICY_STATED':
      return `A new session approval policy was recorded: ${event.payload.text}`
    case 'ANNOTATED':
      return nodes.some((node) => node.id === event.payload.target_id)
        ? `${title(event.payload.target_id)} gained context: ${event.payload.note}`
        : `${edgeTitle(event.payload.target_id)} gained context: ${event.payload.note}`
    case 'JOURNAL_NOTE':
      return event.payload.text
    case 'NODE_STATE_CHANGED':
      if (event.payload.detail === 'worker detached during visitor clone') {
        return 'Recorded worker detached when your private mission copy was created'
      }
      return `${title(event.payload.node_id)} moved from ${event.payload.from} to ${event.payload.to}.`
    case 'PAUSE_ACKED':
      return `${title(event.payload.node_id)} reached a safe pause point.`
    case 'WORKER_LOG':
      return `${title(event.payload.node_id)} reported: ${event.payload.lines.at(-1)}`
    case 'HANDOFF_FILED':
      return `${title(event.payload.node_id)} filed a handoff: ${event.payload.handoff.summary}`
    case 'DEVIATION_NOTED':
      return `${title(event.payload.node_id)} deviated from plan: ${event.payload.text}`
    case 'APPROVAL_CREATED':
      return `${title(event.payload.node_id)} is ready for review: ${event.payload.summary}`
    case 'NODE_MOVED':
      return `${title(event.payload.node_id)} was repositioned on the canvas.`
    case 'SELECTION_CHANGED':
      return 'The active dossier selection changed.'
  }
}
