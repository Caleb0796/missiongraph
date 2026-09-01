import type { GraphEdge, TaskNode } from '../model/types'
import type { MutationBatchItem } from '../transport/client'

export interface SplitSubtask {
  temp_id: string
  title: string
  brief: string
  estimate: number
  tags: string[]
  deps: string[]
}

export interface SplitPlan {
  batch: MutationBatchItem[]
  children: TaskNode[]
  entryIds: string[]
  terminalIds: string[]
  edgeRemap: {
    edgeId: string
    upstream: string
    downstream: string
    kind: GraphEdge['kind']
    newTarget: string
  }[]
}

export function buildSplitPlan(
  parent: TaskNode,
  subtasks: SplitSubtask[],
  edges: GraphEdge[],
  createId: () => string = () => crypto.randomUUID(),
): SplitPlan {
  const ids = new Set(subtasks.map((subtask) => subtask.temp_id))
  if (subtasks.length < 2) throw new Error('subtasks must contain at least two tasks.')
  if (ids.size !== subtasks.length) throw new Error('subtask temp_id values must be unique.')
  for (const subtask of subtasks) {
    for (const dependency of subtask.deps) {
      if (!ids.has(dependency)) {
        throw new Error(`Subtask dependency ${dependency} is outside this split.`)
      }
      if (dependency === subtask.temp_id) {
        throw new Error(`Subtask ${subtask.temp_id} cannot depend on itself.`)
      }
    }
  }

  const pending = new Set(ids)
  while (pending.size > 0) {
    const removable = [...pending].filter((id) => {
      const subtask = subtasks.find((candidate) => candidate.temp_id === id)!
      return subtask.deps.every((dependency) => !pending.has(dependency))
    })
    if (removable.length === 0) throw new Error('Subtask dependencies must be acyclic.')
    removable.forEach((id) => pending.delete(id))
  }

  const childId = new Map(
    subtasks.map((subtask) => [subtask.temp_id, createId()]),
  )
  const children: TaskNode[] = subtasks.map((subtask) => ({
    id: childId.get(subtask.temp_id)!,
    title: subtask.title,
    brief: subtask.brief,
    estimate_min: subtask.estimate,
    tags: subtask.tags,
    state: 'queued',
  }))
  const dependencySources = new Set(
    subtasks.flatMap((subtask) => subtask.deps),
  )
  const entryIds = subtasks
    .filter((subtask) => subtask.deps.length === 0)
    .map((subtask) => childId.get(subtask.temp_id)!)
  const terminalIds = subtasks
    .filter((subtask) => !dependencySources.has(subtask.temp_id))
    .map((subtask) => childId.get(subtask.temp_id)!)
  const incident = edges.filter(
    (edge) => edge.upstream === parent.id || edge.downstream === parent.id,
  )
  const edgeRemap = incident.map((edge) => {
    const targets =
      edge.kind === 'conflicts'
        ? children.map((child) => child.id)
        : edge.downstream === parent.id
          ? entryIds
          : terminalIds
    const newTarget = targets[0]!
    return {
      targets,
      edgeId: edge.edge_id,
      upstream: edge.upstream === parent.id ? newTarget : edge.upstream,
      downstream: edge.downstream === parent.id ? newTarget : edge.downstream,
      kind: edge.kind,
      newTarget,
    }
  })
  const clonedEdges: GraphEdge[] = []
  const previewEdgeRemap = edgeRemap.flatMap(({ targets, ...stable }) => [
    stable,
    ...targets.slice(1).map((newTarget) => {
      const clone = {
        edge_id: createId(),
        upstream:
          stable.upstream === stable.newTarget ? newTarget : stable.upstream,
        downstream:
          stable.downstream === stable.newTarget ? newTarget : stable.downstream,
        kind: stable.kind,
      }
      clonedEdges.push(clone)
      return {
        edgeId: clone.edge_id,
        upstream: clone.upstream,
        downstream: clone.downstream,
        kind: clone.kind,
        newTarget,
      }
    }),
  ])
  const batch: MutationBatchItem[] = [
    {
      type: 'TASK_SPLIT',
      payload: {
        parent_id: parent.id,
        children,
        edge_remap: edgeRemap.map((remap) => ({
          edge_id: remap.edgeId,
          new_target: remap.newTarget,
        })),
      },
    },
    ...clonedEdges.map((edge) => ({
      type: 'EDGE_ADDED' as const,
      payload: edge,
    })),
  ]
  for (const subtask of subtasks) {
    for (const dependency of subtask.deps) {
      batch.push({
        type: 'EDGE_ADDED',
        payload: {
          edge_id: createId(),
          upstream: childId.get(dependency)!,
          downstream: childId.get(subtask.temp_id)!,
          kind: 'depends',
        },
      })
    }
  }

  return {
    batch,
    children,
    entryIds,
    terminalIds,
    edgeRemap: previewEdgeRemap,
  }
}
