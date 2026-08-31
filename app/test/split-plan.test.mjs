import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSplitPlan } from '../src/webmcp/split.ts'

const parent = {
  id: 'payments',
  title: 'Payments',
  brief: 'Implement payments.',
  estimate_min: 30,
  tags: ['api'],
  state: 'running',
}

test('split planner emits one TASK_SPLIT batch with correctly directed edge remaps', () => {
  const edges = [
    {
      edge_id: 'auth-payments',
      upstream: 'auth',
      downstream: 'payments',
      kind: 'depends',
    },
    {
      edge_id: 'payments-receipts',
      upstream: 'payments',
      downstream: 'receipts',
      kind: 'depends',
    },
  ]
  const plan = buildSplitPlan(
    parent,
    [
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
    ],
    edges,
  )
  const [entry] = plan.entryIds
  const [terminal] = plan.terminalIds
  assert.equal(plan.batch[0].type, 'TASK_SPLIT')
  assert.deepEqual(plan.batch[0].payload.edge_remap, [
    { edge_id: 'auth-payments', new_target: entry },
    { edge_id: 'payments-receipts', new_target: terminal },
  ])
  assert.equal(
    plan.batch.filter((item) => item.type === 'EDGE_REMOVED').length,
    2,
  )
  assert.equal(
    plan.batch.filter((item) => item.type === 'PAUSE_REQUESTED').length,
    0,
  )
  const added = plan.batch
    .filter((item) => item.type === 'EDGE_ADDED')
    .map((item) => item.payload)
  assert.ok(
    added.some(
      (edge) =>
        edge.edge_id === 'auth-payments' &&
        edge.upstream === 'auth' &&
        edge.downstream === entry,
    ),
  )
  assert.ok(
    added.some(
      (edge) => edge.upstream === terminal && edge.downstream === 'receipts',
    ),
  )
  assert.ok(
    added.some(
      (edge) => edge.upstream === entry && edge.downstream === terminal,
    ),
  )
})

test('split planner rejects cyclic child dependencies before mutation', () => {
  assert.throws(() =>
    buildSplitPlan(
      parent,
      [
        {
          temp_id: 'a',
          title: 'A',
          brief: 'A.',
          estimate: 5,
          tags: [],
          deps: ['b'],
        },
        {
          temp_id: 'b',
          title: 'B',
          brief: 'B.',
          estimate: 5,
          tags: [],
          deps: ['a'],
        },
      ],
      [],
    ),
  )
})
