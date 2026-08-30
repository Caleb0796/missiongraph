import type { GraphEdge, MissionEvent, TaskNode } from './types'

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
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
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
  for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
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
      return `${edgeTitle(event.payload.target_id)} gained context: ${event.payload.note}`
    case 'JOURNAL_NOTE':
      return event.payload.text
    case 'NODE_STATE_CHANGED':
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
