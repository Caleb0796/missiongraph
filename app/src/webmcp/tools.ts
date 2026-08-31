import {
  approvalQueueFromRanking,
  activeFailedNodes,
  annotationsForTarget,
  approvalsForNode,
  contextualToolNamesForState,
  getCriticalPath,
  getDisplayState,
  isNonIdle,
  isSplitParent,
  remainingPathWeight,
  wouldCreateCycle,
} from '../model/graph'
import type { EdgeKind, GraphEdge, MissionEvent, TaskNode } from '../model/types'
import {
  currentCriticalPath,
  useMissionStore,
  type StructuralPlanInput,
} from '../store/mission-store'
import {
  loadChangesSince,
  mutate,
  mutateBatch,
  prepareBatchMutation,
  prepareMutation,
  type MutationBatchItem,
} from '../transport/client'
import type { ToolDefinition, ToolOutcome } from './registry'
import { buildSplitPlan, type SplitSubtask } from './split'

interface SeedTask {
  temp_id: string
  title: string
  brief: string
  deps: string[]
  estimate: number
  tags: string[]
}

function object(value: unknown, label = 'input') {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`)
  }
  return value
}

function optionalString(value: unknown, label: string) {
  return value === undefined ? undefined : string(value, label)
}

function optionalBoolean(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`)
  return value
}

function number(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`)
  }
  return value
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  const parsed = number(value, label)
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`)
  }
  return parsed
}

function strings(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings.`)
  }
  return value as string[]
}

function entity(id: string) {
  const state = useMissionStore.getState()
  return (
    state.nodes.find((node) => node.id === id) ??
    state.edges.find((edge) => edge.edge_id === id)
  )
}

function node(id: string) {
  const found = useMissionStore.getState().nodes.find((item) => item.id === id)
  if (!found) throw new Error(`Task ${id} does not exist.`)
  return found
}

function approval(id: string) {
  const state = useMissionStore.getState()
  const found = state.approvals[id]
  if (!found || found.status !== 'pending') {
    throw new Error(`Pending approval ${id} does not exist.`)
  }
  return found
}

function preview(
  key: string,
  recompute: () => StructuralPlanInput,
): ToolOutcome {
  const staged = useMissionStore
    .getState()
    .stageStructural(key, recompute)
  return {
    data: {
      summary:
        'This structural change needs confirmation because it touches active or depended-on work.',
    },
    preview: {
      op_token: staged.opToken,
      blast_radius: staged.blastRadius,
    },
  }
}

async function confirmed(
  key: string,
  inputs: Record<string, unknown>,
  ids: string[],
  needsPreview: boolean,
  prepare: () => () => Promise<ToolOutcome>,
  title = 'Confirm structural change',
  recompute: () => StructuralPlanInput & {
    prepare: () => () => Promise<ToolOutcome>
  } = () => ({ title, ids, prepare }),
) {
  if (!needsPreview) return prepare()()
  if (inputs.confirm !== true) return preview(key, recompute)
  const token = string(inputs.op_token, 'op_token')
  const result = await useMissionStore
    .getState()
    .confirmStructuralToken(key, token)
  if (!result.applied && result.preview) {
    return {
      data: {
        summary:
          'The graph changed after this preview. Review the refreshed blast radius before confirming again.',
      },
      preview: {
        op_token: result.preview.opToken,
        blast_radius: result.preview.blastRadius,
      },
      error: {
        code: 'preview_stale',
        message:
          'The graph changed after this preview. Review the refreshed blast radius and confirm again.',
      },
    }
  }
  return result.value as ToolOutcome
}

function pathBetween(from: string, to: string) {
  const { edges } = useMissionStore.getState()
  const queue: { id: string; path: string[] }[] = [{ id: from, path: [from] }]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.id === to) return current.path
    if (visited.has(current.id)) continue
    visited.add(current.id)
    for (const edge of edges
      .filter(
        (candidate) =>
          candidate.kind === 'depends' && candidate.upstream === current.id,
      )
      .sort((left, right) => left.downstream.localeCompare(right.downstream))) {
      queue.push({ id: edge.downstream, path: [...current.path, edge.downstream] })
    }
  }
  return []
}

const emptySchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
}

const confirmProperties = {
  confirm: {
    type: 'boolean',
    description: 'Set true only after reviewing a returned blast-radius preview.',
  },
  op_token: {
    type: 'string',
    description: 'The operation token returned by the matching preview.',
  },
}

const splitSubtasksSchema = {
  type: 'array',
  minItems: 2,
  items: {
    type: 'object',
    properties: {
      temp_id: {
        type: 'string',
        description: 'A unique ID local to this split proposal.',
      },
      title: { type: 'string' },
      brief: { type: 'string' },
      estimate: { type: 'number', exclusiveMinimum: 0 },
      tags: { type: 'array', items: { type: 'string' } },
      deps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Prerequisite temp_id values inside this split.',
      },
    },
    required: ['temp_id', 'title', 'brief', 'estimate', 'tags', 'deps'],
    additionalProperties: false,
  },
}

function splitSubtasks(value: unknown) {
  if (!Array.isArray(value)) throw new Error('subtasks must be an array.')
  return value.map((item, index): SplitSubtask => {
    const subtask = object(item, `subtasks[${index}]`)
    return {
      temp_id: string(subtask.temp_id, `subtasks[${index}].temp_id`),
      title: string(subtask.title, `subtasks[${index}].title`),
      brief: string(subtask.brief, `subtasks[${index}].brief`),
      estimate: number(subtask.estimate, `subtasks[${index}].estimate`),
      tags: strings(subtask.tags, `subtasks[${index}].tags`),
      deps: strings(subtask.deps, `subtasks[${index}].deps`),
    }
  })
}

const planSeed: ToolDefinition = {
  name: 'plan_seed',
  description:
    'Create an initial dependency graph from a goal and an atomically validated batch of tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'The human-readable project goal.' },
      tasks: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            temp_id: {
              type: 'string',
              description: 'A batch-local ID used by dependency references.',
            },
            title: { type: 'string' },
            brief: { type: 'string' },
            deps: { type: 'array', items: { type: 'string' } },
            estimate: { type: 'number', exclusiveMinimum: 0 },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['temp_id', 'title', 'brief', 'deps', 'estimate', 'tags'],
          additionalProperties: false,
        },
      },
    },
    required: ['goal', 'tasks'],
    additionalProperties: false,
  },
  async execute(inputs) {
    const goal = string(inputs.goal, 'goal')
    if (!Array.isArray(inputs.tasks) || inputs.tasks.length === 0) {
      throw new Error('tasks must be a non-empty array.')
    }
    const tasks: SeedTask[] = inputs.tasks.map((value, index) => {
      const task = object(value, `tasks[${index}]`)
      return {
        temp_id: string(task.temp_id, `tasks[${index}].temp_id`),
        title: string(task.title, `tasks[${index}].title`),
        brief: string(task.brief, `tasks[${index}].brief`),
        deps: strings(task.deps, `tasks[${index}].deps`),
        estimate: number(task.estimate, `tasks[${index}].estimate`),
        tags: strings(task.tags, `tasks[${index}].tags`),
      }
    })
    const tempIds = new Set(tasks.map((task) => task.temp_id))
    if (tempIds.size !== tasks.length) throw new Error('temp_id values must be unique.')
    const state = useMissionStore.getState()
    if (state.nodes.some((item) => tempIds.has(item.id))) {
      throw new Error('temp_id values must not collide with persistent task ids.')
    }
    for (const task of tasks) {
      for (const dep of task.deps) {
        if (!tempIds.has(dep) && !state.nodes.some((item) => item.id === dep)) {
          throw new Error(`Dependency ${dep} is not in this batch or the graph.`)
        }
      }
    }
    const batchIds = new Map(
      tasks.map((task) => [
        task.temp_id,
        state.connectionMode === 'fixture' ? crypto.randomUUID() : task.temp_id,
      ]),
    )
    const candidateEdges = [...state.edges]
    const addedEdges: GraphEdge[] = []
    for (const task of tasks) {
      for (const dep of task.deps) {
        const upstream = batchIds.get(dep) ?? dep
        const downstream = batchIds.get(task.temp_id)!
        if (wouldCreateCycle(candidateEdges, upstream, downstream)) {
          throw new Error(`Dependency ${dep} → ${task.temp_id} creates a cycle.`)
        }
        const edge = {
          edge_id:
            state.connectionMode === 'fixture'
              ? crypto.randomUUID()
              : `plan-edge-${crypto.randomUUID()}`,
          upstream,
          downstream,
          kind: 'depends' as const,
        }
        candidateEdges.push(edge)
        addedEdges.push(edge)
      }
    }
    const batch: MutationBatchItem[] = tasks.map((task) => ({
      type: 'TASK_ADDED',
      payload: {
        node: {
          id: batchIds.get(task.temp_id)!,
          title: task.title,
          brief: task.brief,
          estimate_min: task.estimate,
          tags: task.tags,
          state: 'queued',
        },
      },
    }))
    batch.push(
      ...addedEdges.map((edge) => ({
        type: 'EDGE_ADDED' as const,
        payload: edge,
      })),
    )
    const depths = new Map<string, number>()
    const byTempId = new Map(tasks.map((task) => [task.temp_id, task]))
    function depthOf(tempId: string): number {
      const cached = depths.get(tempId)
      if (cached !== undefined) return cached
      const task = byTempId.get(tempId)
      if (!task) return 0
      const depth =
        task.deps.length === 0
          ? 0
          : 1 + Math.max(...task.deps.map((dep) => depthOf(dep)))
      depths.set(tempId, depth)
      return depth
    }
    const rows = new Map<number, number>()
    for (const task of tasks) {
      const depth = depthOf(task.temp_id)
      const row = rows.get(depth) ?? 0
      rows.set(depth, row + 1)
      batch.push({
        type: 'NODE_MOVED',
        payload: {
          node_id: batchIds.get(task.temp_id)!,
          x: depth * 390,
          y: row * 210,
        },
      })
    }
    const seqs = await mutateBatch(batch, { actor: 'browser_agent' })
    const seqSet = new Set(seqs)
    const addedTasks = useMissionStore
      .getState()
      .events.filter(
        (event): event is Extract<MissionEvent, { type: 'TASK_ADDED' }> =>
          event.type === 'TASK_ADDED' && seqSet.has(event.seq),
      )
      .sort((left, right) => left.seq - right.seq)
    if (addedTasks.length !== tasks.length) {
      throw new Error('The atomic plan was applied but its assigned task ids are unavailable.')
    }
    const ids = Object.fromEntries(
      tasks.map((task, index) => [
        task.temp_id,
        addedTasks[index]!.payload.node.id,
      ]),
    )
    return {
      data: {
        summary: `Created ${tasks.length} tasks for “${goal}” and laid out their validated dependency graph.`,
        task_ids: ids,
      },
    }
  },
}

const addTask: ToolDefinition = {
  name: 'add_task',
  description: 'Add one queued task and connect its prerequisite dependencies.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      brief: { type: 'string' },
      deps: { type: 'array', items: { type: 'string' }, default: [] },
      estimate: { type: 'number', exclusiveMinimum: 0 },
      tags: { type: 'array', items: { type: 'string' }, default: [] },
    },
    required: ['title', 'brief', 'estimate'],
    additionalProperties: false,
  },
  async execute(inputs) {
    const title = string(inputs.title, 'title')
    const brief = string(inputs.brief, 'brief')
    const deps = inputs.deps === undefined ? [] : strings(inputs.deps, 'deps')
    const estimate = number(inputs.estimate, 'estimate')
    const tags = inputs.tags === undefined ? [] : strings(inputs.tags, 'tags')
    deps.forEach(node)
    const id = crypto.randomUUID()
    await mutate(
      'TASK_ADDED',
      { node: { id, title, brief, estimate_min: estimate, tags, state: 'queued' } },
      { actor: 'browser_agent' },
    )
    for (const upstream of deps) {
      await mutate(
        'EDGE_ADDED',
        {
          edge_id: crypto.randomUUID(),
          upstream,
          downstream: id,
          kind: 'depends',
        },
        { actor: 'browser_agent' },
      )
    }
    return {
      data: { summary: `Added “${title}” with ${deps.length} prerequisites.`, id },
    }
  },
}

async function executeSplit(
  id: string,
  subtasks: SplitSubtask[],
  inputs: Record<string, unknown>,
  actor: 'human' | 'browser_agent',
) {
  const parent = node(id)
  const recompute = (): StructuralPlanInput & {
    prepare: () => () => Promise<ToolOutcome>
  } => {
    const state = useMissionStore.getState()
    const currentParent = state.nodes.find((candidate) => candidate.id === id)
    if (!currentParent) throw new Error(`Task ${id} does not exist.`)
    if (isSplitParent(currentParent)) {
      throw new Error(`Task ${id} is already a split parent.`)
    }
    const plan = buildSplitPlan(currentParent, subtasks, state.edges)
    const prepare = () => {
      const applyBatch = prepareBatchMutation(plan.batch, {
        actor,
        staleMode: 'silent',
      })
      return async (): Promise<ToolOutcome> => {
        const seqs = await applyBatch()
        const seqSet = new Set(seqs)
        const splitEvent = useMissionStore
          .getState()
          .events.find(
            (event): event is Extract<MissionEvent, { type: 'TASK_SPLIT' }> =>
              event.type === 'TASK_SPLIT' && seqSet.has(event.seq),
          )
        const children = splitEvent?.payload.children ?? plan.children
        const store = useMissionStore.getState()
        store.recordEdgeLineage(plan.edgeLineage)
        store.setHighlights(children.map((child) => child.id))
        store.requestCamera([
          currentParent.id,
          ...children.map((child) => child.id),
        ])
        return {
          data: {
            summary: `Split “${currentParent.title}” into ${children.length} linked tasks in one atomic graph rewire.`,
            parent_id: currentParent.id,
            children: children.map((child) => ({
              id: child.id,
              title: child.title,
            })),
            event_types: plan.batch.map((item) => item.type),
          },
        }
      }
    }
    return {
      title: `Split ${currentParent.title}`,
      ids: [id],
      ...(currentParent.state === 'running'
        ? {
            notice:
              'this task is still executing — the supervisor will re-brief its worker after the split',
          }
        : {}),
      prepare,
    }
  }
  return confirmed(
    `split:${id}`,
    inputs,
    [id],
    true,
    () => recompute().prepare() as () => Promise<ToolOutcome>,
    `Split ${parent.title}`,
    recompute,
  )
}

const splitTask: ToolDefinition = {
  name: 'split_task',
  description:
    'Preview and atomically split a task, remapping prerequisites to entry children and dependents from terminal children.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      subtasks: splitSubtasksSchema,
      ...confirmProperties,
    },
    required: ['id', 'subtasks'],
    additionalProperties: false,
  },
  execute(inputs) {
    return executeSplit(
      string(inputs.id, 'id'),
      splitSubtasks(inputs.subtasks),
      inputs,
      'browser_agent',
    )
  },
}

export function previewNativeSplit(id: string, subtasks: SplitSubtask[]) {
  return executeSplit(id, subtasks, {}, 'human')
}

const link: ToolDefinition = {
  name: 'link',
  description: 'Add a dependency or advisory conflict relationship between two tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      upstream: { type: 'string' },
      downstream: { type: 'string' },
      kind: { type: 'string', enum: ['depends', 'conflicts'] },
      ...confirmProperties,
    },
    required: ['upstream', 'downstream', 'kind'],
    additionalProperties: false,
  },
  async execute(inputs) {
    const upstream = string(inputs.upstream, 'upstream')
    const downstream = string(inputs.downstream, 'downstream')
    const kind = string(inputs.kind, 'kind') as EdgeKind
    if (!['depends', 'conflicts'].includes(kind)) throw new Error('kind is invalid.')
    const upstreamNode = node(upstream)
    const downstreamNode = node(downstream)
    if (
      useMissionStore
        .getState()
        .edges.some(
          (edge) =>
            edge.kind === kind &&
            ((edge.upstream === upstream && edge.downstream === downstream) ||
              (kind === 'conflicts' &&
                edge.upstream === downstream &&
                edge.downstream === upstream)),
        )
    ) {
      throw new Error('That relationship already exists.')
    }
    const edgeId = crypto.randomUUID()
    const key = `link:${upstream}:${downstream}:${kind}`
    const prepare = () => {
      const applyMutation = prepareMutation(
        'EDGE_ADDED',
        { edge_id: edgeId, upstream, downstream, kind },
        { actor: 'browser_agent' },
      )
      return async (): Promise<ToolOutcome> => {
        await applyMutation()
        return {
          data: {
            summary:
              kind === 'depends'
                ? `Linked “${upstreamNode.title}” before “${downstreamNode.title}”.`
                : `Marked a work conflict between “${upstreamNode.title}” and “${downstreamNode.title}”.`,
            edge_id: edgeId,
          },
        }
      }
    }
    return confirmed(
      key,
      inputs,
      [upstream, downstream],
      isNonIdle(upstreamNode) || isNonIdle(downstreamNode),
      prepare,
    )
  },
}

const unlink: ToolDefinition = {
  name: 'unlink',
  description: 'Remove one graph relationship by its stable edge ID.',
  inputSchema: {
    type: 'object',
    properties: { edge_id: { type: 'string' }, ...confirmProperties },
    required: ['edge_id'],
    additionalProperties: false,
  },
  async execute(inputs) {
    const edgeId = string(inputs.edge_id, 'edge_id')
    const state = useMissionStore.getState()
    const edge = state.edges.find((item) => item.edge_id === edgeId)
    if (!edge) throw new Error(`Edge ${edgeId} does not exist.`)
    const touched = [node(edge.upstream), node(edge.downstream)]
    const prepare = () => {
      const applyMutation = prepareMutation(
        'EDGE_REMOVED',
        { edge_id: edgeId },
        { actor: 'browser_agent' },
      )
      return async (): Promise<ToolOutcome> => {
        await applyMutation()
        return {
          data: {
            summary: `Removed the ${edge.kind} relationship between “${touched[0].title}” and “${touched[1].title}”.`,
            edge_id: edgeId,
          },
        }
      }
    }
    return confirmed(
      `unlink:${edgeId}`,
      inputs,
      touched.map((item) => item.id),
      touched.some(isNonIdle),
      prepare,
    )
  },
}

const annotate: ToolDefinition = {
  name: 'annotate',
  description: 'Attach durable human-readable context to a task or relationship.',
  inputSchema: {
    type: 'object',
    properties: { target_id: { type: 'string' }, note: { type: 'string' } },
    required: ['target_id', 'note'],
    additionalProperties: false,
  },
  async execute(inputs) {
    const targetId = string(inputs.target_id, 'target_id')
    const note = string(inputs.note, 'note')
    if (!entity(targetId)) throw new Error(`Target ${targetId} does not exist.`)
    await mutate(
      'ANNOTATED',
      { target_id: targetId, note },
      { actor: 'browser_agent' },
    )
    return {
      data: { summary: `Annotated ${targetId}: ${note}`, target_id: targetId },
    }
  },
}

const remove: ToolDefinition = {
  name: 'remove',
  description: 'Tombstone one task after previewing any impact on active or dependent work.',
  inputSchema: {
    type: 'object',
    properties: { node_id: { type: 'string' }, ...confirmProperties },
    required: ['node_id'],
    additionalProperties: false,
  },
  async execute(inputs) {
    const nodeId = string(inputs.node_id, 'node_id')
    const target = node(nodeId)
    const hasIncidentEdge = useMissionStore
      .getState()
      .edges.some((edge) => edge.upstream === nodeId || edge.downstream === nodeId)
    const prepare = () => {
      const applyMutation = prepareMutation(
        'TASK_REMOVED',
        { node_id: nodeId, tombstone: true },
        { actor: 'browser_agent' },
      )
      return async (): Promise<ToolOutcome> => {
        await applyMutation()
        return {
          data: {
            summary: `Tombstoned and removed “${target.title}”.`,
            node_id: nodeId,
          },
        }
      }
    }
    return confirmed(
      `remove:${nodeId}`,
      inputs,
      [nodeId],
      isNonIdle(target) || hasIncidentEdge,
      prepare,
    )
  },
}

function digestData() {
  const state = useMissionStore.getState()
  const activeNodes = state.nodes.filter((current) => !isSplitParent(current))
  const counts = {
    ready: 0,
    blocked: 0,
    running: 0,
    review: 0,
    done: 0,
    failed: 0,
    paused: 0,
  }
  for (const current of activeNodes) {
    const display = getDisplayState(current, state.nodes, state.edges)
    counts[display as keyof typeof counts]++
  }
  const critical = getCriticalPath(activeNodes, state.edges)
  const pendingApprovals = approvalQueueFromRanking(
    state.approvals,
    state.approvalRanking,
  ).map((item) => ({
      approval_id: item.id,
      node_id: item.node_id,
      node_title:
        state.nodes.find((node) => node.id === item.node_id)?.title ?? item.node_id,
      summary: item.summary,
      delay_impact_min: item.delayImpactMin,
    }))
  const ready = activeNodes
    .filter(
      (current) =>
        getDisplayState(current, state.nodes, state.edges) === 'ready' &&
        !(current as TaskNode & { assigned?: boolean }).assigned,
    )
    .map((current) => ({
      id: current.id,
      title: current.title,
      idle_since: state.readySince[current.id] ?? null,
    }))
    .sort(
      (left, right) =>
        (left.idle_since ?? '').localeCompare(right.idle_since ?? '') ||
        left.id.localeCompare(right.id),
    )
  return {
    summary: `The graph has ${activeNodes.length} active tasks and ${state.nodes.length - activeNodes.length} split-parent history records; ${counts.running} are running, ${counts.review} await review, ${counts.failed} failed, and ${counts.done} are done.`,
    counts_by_state: counts,
    critical_path: {
      node_ids: critical.nodeIds,
      edge_ids: critical.edgeIds,
      eta_min: critical.eta,
    },
    tasks: activeNodes.map((current) => ({
      id: current.id,
      title: current.title,
      state: getDisplayState(current, state.nodes, state.edges),
    })),
    split_parents: state.nodes
      .filter(isSplitParent)
      .map((current) => ({
        id: current.id,
        title: current.title,
        child_ids:
          (current as TaskNode & { child_ids?: string[] }).child_ids ?? [],
      })),
    edges: state.edges,
    pending_approvals: pendingApprovals,
    approval_ordering_source:
      state.approvalRankingSource === 'fixture'
        ? 'fixture-local estimate'
        : state.approvalRankingSource,
    ready_unassigned: ready,
  }
}

const graphDigest: ToolDefinition = {
  name: 'graph_digest',
  description: 'Summarize current graph health and return changes since a cursor.',
  inputSchema: {
    type: 'object',
    properties: {
      since: {
        type: 'string',
        pattern: '^\\d+$',
        description: 'Optional cursor override for this digest call.',
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async execute(inputs) {
    if (inputs.since !== undefined && !/^\d+$/.test(string(inputs.since, 'since'))) {
      throw new Error('since must be a numeric cursor string.')
    }
    if (typeof inputs.since === 'string') await loadChangesSince(inputs.since)
    return { data: digestData() }
  },
}

const listReady: ToolDefinition = {
  name: 'list_ready',
  description: 'List unblocked unassigned tasks that are ready for a worker.',
  inputSchema: emptySchema,
  annotations: { readOnlyHint: true },
  execute() {
    const state = useMissionStore.getState()
    const critical = currentCriticalPath()
    const ready = state.nodes
      .filter(
        (current) =>
          getDisplayState(current, state.nodes, state.edges) === 'ready' &&
          !(current as TaskNode & { assigned?: boolean }).assigned,
      )
      .map((current) => ({
        id: current.id,
        title: current.title,
        idle_since:
          state.readySince[current.id] ??
          (current as TaskNode & { ready_since?: string }).ready_since ??
          'just became ready',
        on_critical_path: critical.nodeIds.includes(current.id),
        ...(state.connectionMode === 'fixture'
          ? {
              remaining_path_min: remainingPathWeight(
                current.id,
                state.nodes,
                state.edges,
              ),
              slack_min:
                critical.eta -
                remainingPathWeight(current.id, state.nodes, state.edges),
              distance_source: 'fixture-local estimate',
            }
          : { distance_source: 'server critical-path membership' }),
      }))
    return {
      data: {
        summary:
          ready.length === 0
            ? 'No unassigned tasks are ready right now.'
            : `${ready.length} unassigned ${ready.length === 1 ? 'task is' : 'tasks are'} ready.`,
        tasks: ready,
      },
    }
  },
}

const listPendingApprovals: ToolDefinition = {
  name: 'list_pending_approvals',
  description: 'List pending reviews ranked by projected critical-path delay and age.',
  inputSchema: emptySchema,
  annotations: { readOnlyHint: true },
  execute() {
    const state = useMissionStore.getState()
    const approvals = approvalQueueFromRanking(
      state.approvals,
      state.approvalRanking,
    ).map((item) => ({
      ...item,
      node_title:
        state.nodes.find((node) => node.id === item.node_id)?.title ?? item.node_id,
      delay_impact_min: item.delayImpactMin,
    }))
    return {
      data: {
        summary:
          approvals.length === 0
            ? 'No approvals are pending.'
            : `${approvals.length} approvals are pending, ordered by projected delay.`,
        approvals,
        ordering_source:
          state.approvalRankingSource === 'fixture'
            ? 'fixture-local estimate'
            : state.approvalRankingSource,
      },
    }
  },
}

const statePolicy: ToolDefinition = {
  name: 'state_policy',
  description:
    'Record the human’s verbatim approval policy for this browser session and mint its policy reference.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The human-stated approval policy.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  async execute(inputs) {
    const text = string(inputs.text, 'text')
    const sessionId = useMissionStore.getState().sessionId
    if (!sessionId) throw new Error('The browser session identity is not ready.')
    const policyRef = crypto.randomUUID()
    await mutate(
      'POLICY_STATED',
      { policy_ref: policyRef, text, scope: 'session', session_id: sessionId },
      { actor: 'browser_agent' },
    )
    return {
      data: {
        summary: `Recorded the session approval policy: ${text}`,
        policy_ref: policyRef,
        scope: 'session',
      },
    }
  },
}

const approve: ToolDefinition = {
  name: 'approve',
  description: 'Approve pending work under a human-stated session policy.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The pending approval ID.' },
      policy_ref: { type: 'string' },
      rationale: { type: 'string' },
    },
    required: ['id', 'policy_ref'],
    additionalProperties: false,
  },
  async execute(inputs) {
    const policyRef = string(inputs.policy_ref, 'policy_ref')
    const item = approval(string(inputs.id, 'id'))
    const rationale = optionalString(inputs.rationale, 'rationale')
    await mutate(
      'APPROVED',
      {
        approval_id: item.id,
        node_id: item.node_id,
        policy_ref: policyRef,
        ...(rationale ? { rationale } : {}),
      },
      { actor: 'browser_agent' },
    )
    return {
      data: {
        summary: `Approved “${node(item.node_id).title}” under policy ${policyRef}.`,
        approval_id: item.id,
      },
    }
  },
}

const reject: ToolDefinition = {
  name: 'reject',
  description: 'Reject pending work with revision guidance under a session policy.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The pending approval ID.' },
      reason: { type: 'string', description: 'Actionable guidance for the worker.' },
      policy_ref: { type: 'string' },
    },
    required: ['id', 'reason', 'policy_ref'],
    additionalProperties: false,
  },
  async execute(inputs) {
    const reason = string(inputs.reason, 'reason')
    const policyRef = string(inputs.policy_ref, 'policy_ref')
    const item = approval(string(inputs.id, 'id'))
    await mutate(
      'REJECTED',
      {
        approval_id: item.id,
        node_id: item.node_id,
        reason,
        policy_ref: policyRef,
      },
      { actor: 'browser_agent' },
    )
    return {
      data: {
        summary: `Rejected “${node(item.node_id).title}” with guidance: ${reason}`,
        approval_id: item.id,
      },
    }
  },
}

const dispatch: ToolDefinition = {
  name: 'dispatch',
  description: 'Dispatch a ready unassigned task to the Codex supervisor.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The ready task ID.' },
      brief_override: { type: 'string' },
      bypass_cap: {
        type: 'boolean',
        default: true,
        description: 'Whether this explicit dispatch may use the one-slot cap bypass.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(inputs) {
    const id = string(inputs.id, 'id')
    const target = node(id)
    const briefOverride = optionalString(inputs.brief_override, 'brief_override')
    const bypassCap = optionalBoolean(inputs.bypass_cap, 'bypass_cap') ?? true
    await mutate(
      'DISPATCHED',
      {
        node_id: id,
        ...(briefOverride ? { brief_override: briefOverride } : {}),
        bypass_cap: bypassCap,
      },
      { actor: 'browser_agent' },
    )
    return {
      data: {
        summary: `Dispatched “${target.title}” to the Codex supervisor.`,
        node_id: id,
        bypass_cap: bypassCap,
      },
    }
  },
}

const retryWithGuidance: ToolDefinition = {
  name: 'retry_with_guidance',
  description: 'Request another attempt on a failed task with actionable guidance.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The failed task ID.' },
      guidance: { type: 'string', minLength: 1 },
    },
    required: ['id', 'guidance'],
    additionalProperties: false,
  },
  async execute(inputs) {
    const id = string(inputs.id, 'id')
    const target = node(id)
    const guidance = string(inputs.guidance, 'guidance')
    await mutate(
      'RETRY_REQUESTED',
      { node_id: id, guidance },
      { actor: 'browser_agent' },
    )
    return {
      data: {
        summary: `Requested another attempt on “${target.title}” with guidance: ${guidance}`,
        node_id: id,
      },
    }
  },
}

const setNodeRunState: ToolDefinition = {
  name: 'set_node_run_state',
  description: 'Request a cooperative pause or resume for one active task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      state: { type: 'string', enum: ['pause', 'resume'] },
    },
    required: ['id', 'state'],
    additionalProperties: false,
  },
  async execute(inputs) {
    const id = string(inputs.id, 'id')
    const target = node(id)
    if (isSplitParent(target)) {
      throw new Error('A split-parent history record cannot run or pause.')
    }
    const state = string(inputs.state, 'state')
    if (!['pause', 'resume'].includes(state)) {
      throw new Error('state must be pause or resume.')
    }
    if (state === 'pause' && target.state !== 'running') {
      throw new Error('Only a running task can be asked to pause.')
    }
    if (state === 'resume' && target.state !== 'paused') {
      throw new Error('Only a paused task can be asked to resume.')
    }
    await mutate(
      state === 'pause' ? 'PAUSE_REQUESTED' : 'RESUME_REQUESTED',
      { node_id: id },
      { actor: 'browser_agent' },
    )
    return {
      data: {
        summary:
          state === 'pause'
            ? `Asked “${target.title}” to pause at a safe point.`
            : `Asked “${target.title}” to resume.`,
        node_id: id,
        requested_state: state,
      },
    }
  },
}

const getNode: ToolDefinition = {
  name: 'get_node',
  description: 'Return the complete human-readable dossier for a task or relationship.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  execute(inputs) {
    const id = string(inputs.id, 'id')
    const state = useMissionStore.getState()
    const task = state.nodes.find((item) => item.id === id)
    if (task) {
      const itemApprovals = approvalsForNode(state.approvals, id)
      const splitParent = task.parent_id
        ? state.nodes.find((candidate) => candidate.id === task.parent_id)
        : undefined
      return {
        data: {
          summary: `“${task.title}” is ${getDisplayState(task, state.nodes, state.edges)}: ${task.brief}`,
          node: task,
          handoff: state.handoffs[id] ?? null,
          deviations: state.deviations[id] ?? [],
          decision_trail: itemApprovals,
          annotations: state.annotations[id] ?? [],
          worker_log_tail: state.workerLogs[id] ?? [],
          split_history: splitParent
            ? {
                parent_id: splitParent.id,
                parent_title: splitParent.title,
                parent_handoff: state.handoffs[splitParent.id] ?? null,
                summary: `This task was split from “${splitParent.title}”; the parent dossier preserves its earlier work and decisions.`,
              }
            : null,
        },
      }
    }
    const edge = state.edges.find((item) => item.edge_id === id)
    if (!edge) throw new Error(`Task or edge ${id} does not exist.`)
    const upstream = node(edge.upstream)
    const downstream = node(edge.downstream)
    return {
      data: {
        summary:
          edge.kind === 'depends'
            ? `“${downstream.title}” depends on “${upstream.title}”.`
            : `“${upstream.title}” and “${downstream.title}” have an advisory work conflict.`,
        edge,
        annotations: annotationsForTarget(
          state.annotations,
          state.edgeLineage,
          id,
        ),
      },
    }
  },
}

const getCriticalPathTool: ToolDefinition = {
  name: 'get_critical_path',
  description: 'Return the longest remaining dependency path with its estimated duration.',
  inputSchema: emptySchema,
  annotations: { readOnlyHint: true },
  execute() {
    const state = useMissionStore.getState()
    const path = getCriticalPath(state.nodes, state.edges)
    return {
      data: {
        summary:
          path.nodeIds.length === 0
            ? 'The graph is empty, so there is no critical path.'
            : `The critical path spans ${path.nodeIds.length} tasks with ${path.eta} estimated minutes remaining.`,
        node_ids: path.nodeIds,
        edge_ids: path.edgeIds,
        eta_min: path.eta,
      },
    }
  },
}

const getSelection: ToolDefinition = {
  name: 'get_selection',
  description: 'Return the task or relationship currently selected by the human.',
  inputSchema: emptySchema,
  annotations: { readOnlyHint: true },
  execute() {
    const selected = useMissionStore.getState().selectedId
    return {
      data: {
        summary: selected
          ? `The human currently has ${selected} selected.`
          : 'The human has not selected a task or relationship.',
        selected: selected ? [selected] : [],
      },
    }
  },
}

const focus: ToolDefinition = {
  name: 'focus',
  description: 'Pan and zoom the canvas to frame one or more tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', minItems: 1, items: { type: 'string' } },
    },
    required: ['ids'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  execute(inputs) {
    const ids = strings(inputs.ids, 'ids')
    if (ids.length === 0) throw new Error('ids must not be empty.')
    ids.forEach(node)
    const store = useMissionStore.getState()
    store.requestCamera(ids)
    store.showToast(`🤖 via your agent — Focused ${ids.length} task${ids.length === 1 ? '' : 's'}.`)
    return {
      data: { summary: `Focused the canvas on ${ids.join(', ')}.`, node_ids: ids },
    }
  },
}

const highlightPath: ToolDefinition = {
  name: 'highlight_path',
  description: 'Highlight and frame either the critical path or a dependency path between two tasks.',
  inputSchema: {
    oneOf: [
      {
        type: 'object',
        properties: { mode: { const: 'critical' } },
        required: ['mode'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          mode: { const: 'between' },
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['mode', 'from', 'to'],
        additionalProperties: false,
      },
    ],
  },
  annotations: { readOnlyHint: true },
  execute(inputs) {
    const mode = string(inputs.mode, 'mode')
    let path: string[]
    if (mode === 'critical') {
      path = currentCriticalPath().nodeIds
    } else if (mode === 'between') {
      const from = string(inputs.from, 'from')
      const to = string(inputs.to, 'to')
      node(from)
      node(to)
      path = pathBetween(from, to)
      if (path.length === 0) {
        throw new Error(`No directed dependency path connects ${from} to ${to}.`)
      }
    } else {
      throw new Error('mode must be critical or between.')
    }
    const store = useMissionStore.getState()
    store.setHighlights(path)
    store.requestCamera(path)
    store.showToast(`🤖 via your agent — Highlighted the ${mode} path.`)
    return {
      data: {
        summary:
          path.length === 0
            ? 'The graph is empty, so no path was highlighted.'
            : `Highlighted and framed ${path.length} tasks on the ${mode} path.`,
        node_ids: path,
      },
    }
  },
}

const explainOverlay: ToolDefinition = {
  name: 'explain_overlay',
  description: 'Place a temporary, anchored explanatory callout on one task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      text: { type: 'string' },
      ttl: {
        type: 'number',
        minimum: 1,
        maximum: 60,
        description: 'Seconds before the callout disappears.',
      },
    },
    required: ['id', 'text', 'ttl'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  execute(inputs) {
    const id = string(inputs.id, 'id')
    const target = node(id)
    const text = string(inputs.text, 'text')
    const ttl = boundedNumber(inputs.ttl, 'ttl', 1, 60)
    const store = useMissionStore.getState()
    store.showExplainOverlay(id, text, ttl)
    store.requestCamera([id])
    return {
      data: {
        summary: `Placed an explanation on “${target.title}” for ${ttl} seconds.`,
        node_id: id,
      },
    }
  },
}

const journalNote: ToolDefinition = {
  name: 'journal_note',
  description: 'Record a durable project-level decision or rewire note.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  async execute(inputs) {
    const text = string(inputs.text, 'text')
    await mutate('JOURNAL_NOTE', { text }, { actor: 'browser_agent' })
    return { data: { summary: `Recorded in the project journal: ${text}` } }
  },
}

const getJournal: ToolDefinition = {
  name: 'get_journal',
  description: 'Read project-level decisions and rewire notes after an optional cursor.',
  inputSchema: {
    type: 'object',
    properties: { since: { type: 'string', pattern: '^\\d+$' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  execute(inputs) {
    const since =
      inputs.since === undefined ? 0 : Number(string(inputs.since, 'since'))
    if (!Number.isInteger(since) || since < 0) {
      throw new Error('since must be a numeric cursor string.')
    }
    const entries = useMissionStore
      .getState()
      .journal.filter((entry) => entry.seq > since)
    return {
      data: {
        summary:
          entries.length === 0
            ? 'No project journal entries match this cursor.'
            : `${entries.length} project journal ${entries.length === 1 ? 'entry' : 'entries'} matched.`,
        entries,
      },
    }
  },
}

function notApplicable(name: string, reason: string): ToolOutcome {
  return {
    data: {
      label: 'not_applicable',
      tool: name,
      applicable: false,
      summary: reason,
    },
  }
}

function selectedNode() {
  const state = useMissionStore.getState()
  return state.nodes.find(
    (candidate) =>
      candidate.id === state.selectedId && !isSplitParent(candidate),
  )
}

const dispatchSelected: ToolDefinition = {
  name: 'dispatch_selected',
  description: 'Dispatch the currently selected ready, unassigned task.',
  inputSchema: {
    type: 'object',
    properties: { brief_override: { type: 'string' } },
    additionalProperties: false,
  },
  async execute(inputs, options) {
    const selected = selectedNode()
    if (!selected) {
      return notApplicable('dispatch_selected', 'Select a task before dispatching it.')
    }
    const state = useMissionStore.getState()
    if (
      getDisplayState(selected, state.nodes, state.edges) !== 'ready' ||
      (selected as TaskNode & { assigned?: boolean }).assigned
    ) {
      return notApplicable(
        'dispatch_selected',
        `“${selected.title}” is not ready and unassigned.`,
      )
    }
    return dispatch.execute(
      { id: selected.id, brief_override: inputs.brief_override },
      options,
    )
  },
}

const explainSelected: ToolDefinition = {
  name: 'explain_selected',
  description: 'Read the complete dossier for the currently selected task or edge.',
  inputSchema: emptySchema,
  annotations: { readOnlyHint: true },
  execute(inputs, options) {
    const state = useMissionStore.getState()
    const selectedId = state.selectedId
    if (!selectedId) {
      return notApplicable('explain_selected', 'Select a task or edge to explain it.')
    }
    const selectedTask = state.nodes.find(
      (candidate) => candidate.id === selectedId,
    )
    if (selectedTask && isSplitParent(selectedTask)) {
      return notApplicable(
        'explain_selected',
        'Retired split parents are not contextual action targets.',
      )
    }
    return getNode.execute({ ...inputs, id: selectedId }, options)
  },
}

const annotateSelected: ToolDefinition = {
  name: 'annotate_selected',
  description: 'Attach durable context to the currently selected task.',
  inputSchema: {
    type: 'object',
    properties: { note: { type: 'string' } },
    required: ['note'],
    additionalProperties: false,
  },
  execute(inputs, options) {
    const selected = selectedNode()
    if (!selected) {
      return notApplicable('annotate_selected', 'Select a task before annotating it.')
    }
    return annotate.execute(
      { target_id: selected.id, note: inputs.note },
      options,
    )
  },
}

const splitSelected: ToolDefinition = {
  name: 'split_selected',
  description: 'Preview and atomically split the currently selected task.',
  inputSchema: {
    type: 'object',
    properties: { subtasks: splitSubtasksSchema, ...confirmProperties },
    required: ['subtasks'],
    additionalProperties: false,
  },
  execute(inputs) {
    const selected = selectedNode()
    if (!selected) {
      return notApplicable('split_selected', 'Select a task before splitting it.')
    }
    return executeSplit(
      selected.id,
      splitSubtasks(inputs.subtasks),
      inputs,
      'browser_agent',
    )
  },
}

const reviewFailures: ToolDefinition = {
  name: 'review_failures',
  description: 'Summarize failed tasks and focus them on the canvas without mutating.',
  inputSchema: emptySchema,
  annotations: { readOnlyHint: true },
  execute() {
    const store = useMissionStore.getState()
    const failed = activeFailedNodes(store.nodes)
    if (failed.length === 0) {
      return notApplicable('review_failures', 'No tasks are currently failed.')
    }
    const ids = failed.map((candidate) => candidate.id)
    store.setHighlights(ids)
    store.requestCamera(ids)
    return {
      data: {
        summary: `${failed.length} failed ${failed.length === 1 ? 'task needs' : 'tasks need'} review.`,
        tasks: failed.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          log_tail: store.workerLogs[candidate.id]?.slice(-5) ?? [],
        })),
      },
    }
  },
}

export const missionTools: ToolDefinition[] = [
  planSeed,
  addTask,
  splitTask,
  link,
  unlink,
  annotate,
  remove,
  graphDigest,
  listReady,
  listPendingApprovals,
  statePolicy,
  approve,
  reject,
  dispatch,
  retryWithGuidance,
  setNodeRunState,
  getNode,
  getCriticalPathTool,
  getSelection,
  focus,
  highlightPath,
  explainOverlay,
  journalNote,
  getJournal,
]

export const contextualMissionTools: ToolDefinition[] = [
  dispatchSelected,
  explainSelected,
  annotateSelected,
  splitSelected,
  reviewFailures,
]

export function contextualToolsForCurrentState() {
  const state = useMissionStore.getState()
  const byName = new Map(
    contextualMissionTools.map((definition) => [definition.name, definition]),
  )
  return contextualToolNamesForState(
    state.nodes,
    state.edges,
    state.selectedId,
  ).flatMap((name) => byName.get(name) ?? [])
}
