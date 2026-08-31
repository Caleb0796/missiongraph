import assert from 'node:assert/strict'
import test from 'node:test'

import { foldTaskSplit } from '../src/model/graph.ts'
import { StructuralConfirmationController } from '../src/store/structural-confirmation.ts'
import { buildSplitPlan } from '../src/webmcp/split.ts'

const parent = {
  id: 'payments',
  title: 'Payments',
  brief: 'Implement payments.',
  estimate_min: 30,
  tags: ['api'],
  state: 'queued',
}
const subtasks = [
  {
    temp_id: 'model',
    title: 'Payment model',
    brief: 'Model payment state.',
    estimate: 10,
    tags: ['api'],
    deps: [],
  },
  {
    temp_id: 'capture',
    title: 'Payment capture',
    brief: 'Capture a payment.',
    estimate: 20,
    tags: ['api'],
    deps: ['model'],
  },
]

function applyPlan(nodes, edges, plan) {
  let nextNodes = nodes
  let nextEdges = edges
  for (const item of plan.batch) {
    if (item.type === 'TASK_SPLIT') {
      ;({ nodes: nextNodes, edges: nextEdges } = foldTaskSplit(
        nextNodes,
        nextEdges,
        item.payload,
      ))
    } else if (item.type === 'EDGE_REMOVED') {
      nextEdges = nextEdges.filter(
        (edge) => edge.edge_id !== item.payload.edge_id,
      )
    } else if (item.type === 'EDGE_ADDED') {
      nextEdges = [...nextEdges, item.payload]
    }
  }
  return { nodes: nextNodes, edges: nextEdges }
}

test('stale split re-preview recomputes children and preserves a concurrent incident edge', async () => {
  let cursor = '8'
  let token = 0
  let nodes = [
    { id: 'auth', title: 'Auth', brief: 'Auth.', estimate_min: 5, tags: [], state: 'done' },
    parent,
    { id: 'receipt', title: 'Receipt', brief: 'Receipt.', estimate_min: 5, tags: [], state: 'queued' },
  ]
  let edges = [
    { edge_id: 'auth-payments', upstream: 'auth', downstream: 'payments', kind: 'depends' },
  ]
  const plans = []
  const controller = new StructuralConfirmationController(
    () => `token-${++token}`,
  )
  const recompute = () => {
    const plan = buildSplitPlan(parent, subtasks, edges)
    plans.push(plan)
    return {
      title: 'Split Payments',
      ids: ['payments'],
      apply: async () => {
        ;({ nodes, edges } = applyPlan(nodes, edges, plan))
        return plan
      },
    }
  }
  const operation = controller.stage({
    key: 'split:payments',
    cursor,
    projectId: 'project-a',
    recompute,
  })
  const originalChildren = plans[0].children.map((child) => child.id)

  edges.push({
    edge_id: 'payments-receipt',
    upstream: 'payments',
    downstream: 'receipt',
    kind: 'depends',
  })
  cursor = '9'
  const stale = await controller.confirm(
    operation.key,
    operation.opToken,
    { cursor, projectId: 'project-a' },
    () => ({ cursor, projectId: 'project-a' }),
    () => false,
  )
  assert.equal(stale.applied, false)
  assert.equal(stale.operation.opToken, 'token-2')
  assert.notDeepEqual(
    plans[1].children.map((child) => child.id),
    originalChildren,
  )
  assert.ok(
    plans[1].batch[0].payload.edge_remap.some(
      (remap) => remap.edge_id === 'payments-receipt',
    ),
  )

  const confirmed = await controller.confirm(
    operation.key,
    stale.operation.opToken,
    { cursor, projectId: 'project-a' },
    () => ({ cursor, projectId: 'project-a' }),
    () => false,
  )
  assert.equal(confirmed.applied, true)
  assert.ok(edges.some((edge) => edge.edge_id === 'payments-receipt'))
  assert.ok(
    edges.every(
      (edge) => edge.upstream !== 'payments' && edge.downstream !== 'payments',
    ),
  )
})

test('a confirm-time 409 keeps the operation and rebinds a recomputed preview', async () => {
  let cursor = '8'
  let token = 0
  let plans = 0
  const controller = new StructuralConfirmationController(
    () => `token-${++token}`,
  )
  const operation = controller.stage({
    key: 'split:payments',
    cursor,
    projectId: 'project-a',
    recompute: () => {
      const planNumber = ++plans
      return {
        title: 'Split Payments',
        ids: ['payments'],
        apply: async () => {
          if (planNumber === 1) {
            cursor = '9'
            throw { code: 'stale_mutation' }
          }
          return planNumber
        },
      }
    },
  })
  const stale = await controller.confirm(
    operation.key,
    operation.opToken,
    { cursor: '8', projectId: 'project-a' },
    () => ({ cursor, projectId: 'project-a' }),
    (error) => error?.code === 'stale_mutation',
  )
  assert.equal(stale.applied, false)
  assert.equal(stale.operation.baseCursor, '9')
  assert.equal(stale.operation.opToken, 'token-2')
  assert.equal(plans, 2)
  assert.deepEqual(
    await controller.confirm(
      operation.key,
      stale.operation.opToken,
      { cursor: '9', projectId: 'project-a' },
      () => ({ cursor, projectId: 'project-a' }),
      () => false,
    ),
    { applied: true, value: 2 },
  )
})

test('confirmation cannot cross project identity', async () => {
  const controller = new StructuralConfirmationController(() => 'token')
  const operation = controller.stage({
    key: 'split:payments',
    cursor: '8',
    projectId: 'project-a',
    recompute: () => ({
      title: 'Split Payments',
      ids: ['payments'],
      apply: async () => undefined,
    }),
  })
  await assert.rejects(
    controller.confirm(
      operation.key,
      operation.opToken,
      { cursor: '8', projectId: 'project-b' },
      () => ({ cursor: '8', projectId: 'project-b' }),
      () => false,
    ),
    /project changed/,
  )
  await assert.rejects(
    controller.confirm(
      operation.key,
      operation.opToken,
      { cursor: '8', projectId: 'project-a' },
      () => ({ cursor: '8', projectId: 'project-a' }),
      () => false,
    ),
    /missing, expired/,
  )
})
