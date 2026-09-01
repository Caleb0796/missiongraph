import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONTENT_POLICY,
  contentSafeAnnotations,
  contentSafeEnvelope,
} from '../src/webmcp/content-policy.ts'
import { addTaskWithDependencies } from '../src/webmcp/task-mutations.ts'
import { buildSplitPlan } from '../src/webmcp/split.ts'

const splitParent = {
  id: 'parent',
  title: 'Parent',
  brief: 'Split this task.',
  estimate_min: 30,
  tags: [],
  state: 'running',
}

function splitPlan(subtasks, edges) {
  let id = 0
  return buildSplitPlan(splitParent, subtasks, edges, () => `generated-${++id}`)
}

test('shared envelopes label and bound untrusted prose, and every tool carries the hint', () => {
  const longText = 'x'.repeat(2_050)
  const safe = contentSafeEnvelope(
    {
      data: {
        entries: [{ text: longText }],
        worker_log_tail: [longText],
      },
    },
    Array.from({ length: 60 }, (_, index) => ({
      seq: index + 1,
      actor: 'worker:test',
      type: 'WORKER_LOG',
      one_liner: longText,
    })),
  )

  assert.equal(safe.contentPolicy, CONTENT_POLICY)
  assert.equal(safe.changes.length, 50)
  assert.equal(safe.changes[0].seq, 11)
  assert.equal(safe.changes[0].truncated, true)
  assert.equal(safe.changes[0].one_liner.length, 2_000)
  assert.match(safe.changes[0].one_liner, /…\[truncated\]$/)
  assert.equal(safe.outcome.data.entries[0].truncated, true)
  assert.equal(safe.outcome.data.entries[0].text.length, 2_000)
  assert.equal(safe.outcome.data.truncated, true)
  assert.equal(safe.outcome.data.worker_log_tail[0].length, 2_000)
  assert.deepEqual(contentSafeAnnotations({ readOnlyHint: true }), {
    readOnlyHint: true,
    untrustedContentHint: true,
  })
  assert.deepEqual(contentSafeAnnotations(), { untrustedContentHint: true })
})

test('add_task submits the task and every dependency through one atomic batch', async () => {
  const calls = []
  const confirmationRequired = Object.assign(new Error('Confirm this batch.'), {
    code: 'confirmation_required',
  })
  const fakeTransport = async (batch, options) => {
    calls.push({ batch, options })
    throw confirmationRequired
  }
  const task = {
    id: 'new-task',
    title: 'New task',
    brief: 'Do all of it.',
    estimate_min: 15,
    tags: ['freeze'],
    state: 'queued',
  }
  let edge = 0

  await assert.rejects(
    addTaskWithDependencies(
      task,
      ['started-a', 'started-b'],
      fakeTransport,
      () => `edge-${++edge}`,
    ),
    (error) => error === confirmationRequired,
  )
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    options: { actor: 'browser_agent' },
    batch: [
      { type: 'TASK_ADDED', payload: { node: task } },
      {
        type: 'EDGE_ADDED',
        payload: {
          edge_id: 'edge-1',
          upstream: 'started-a',
          downstream: 'new-task',
          kind: 'depends',
        },
      },
      {
        type: 'EDGE_ADDED',
        payload: {
          edge_id: 'edge-2',
          upstream: 'started-b',
          downstream: 'new-task',
          kind: 'depends',
        },
      },
    ],
  })
})

test('split preserves linear incident-edge rewiring without clones', () => {
  const plan = splitPlan(
    [
      { temp_id: 'first', title: 'First', brief: 'First.', estimate: 10, tags: [], deps: [] },
      { temp_id: 'last', title: 'Last', brief: 'Last.', estimate: 20, tags: [], deps: ['first'] },
    ],
    [
      { edge_id: 'incoming', upstream: 'before', downstream: 'parent', kind: 'depends' },
      { edge_id: 'outgoing', upstream: 'parent', downstream: 'after', kind: 'depends' },
    ],
  )
  const added = plan.batch.filter((item) => item.type === 'EDGE_ADDED')

  assert.equal(plan.edgeRemap.length, 2)
  assert.deepEqual(plan.batch[0].payload.edge_remap, [
    { edge_id: 'incoming', new_target: plan.entryIds[0] },
    { edge_id: 'outgoing', new_target: plan.terminalIds[0] },
  ])
  assert.equal(added.length, 1)
  assert.equal(added[0].payload.upstream, plan.entryIds[0])
  assert.equal(added[0].payload.downstream, plan.terminalIds[0])
})

test('split rewires every parallel entry, terminal, and conflict target', () => {
  const plan = splitPlan(
    [
      { temp_id: 'left', title: 'Left', brief: 'Left.', estimate: 10, tags: [], deps: [] },
      { temp_id: 'right', title: 'Right', brief: 'Right.', estimate: 10, tags: [], deps: [] },
    ],
    [
      { edge_id: 'incoming', upstream: 'before', downstream: 'parent', kind: 'depends' },
      { edge_id: 'outgoing', upstream: 'parent', downstream: 'after', kind: 'depends' },
      { edge_id: 'conflict', upstream: 'parent', downstream: 'rival', kind: 'conflicts' },
    ],
  )
  const resulting = plan.edgeRemap.map(({ upstream, downstream, kind }) => ({
    upstream,
    downstream,
    kind,
  }))

  assert.deepEqual(
    resulting.filter((edge) => edge.upstream === 'before'),
    plan.entryIds.map((downstream) => ({
      upstream: 'before',
      downstream,
      kind: 'depends',
    })),
  )
  assert.deepEqual(
    resulting.filter((edge) => edge.downstream === 'after'),
    plan.terminalIds.map((upstream) => ({
      upstream,
      downstream: 'after',
      kind: 'depends',
    })),
  )
  assert.deepEqual(
    resulting.filter((edge) => edge.downstream === 'rival'),
    plan.children.map((child) => ({
      upstream: child.id,
      downstream: 'rival',
      kind: 'conflicts',
    })),
  )
  assert.equal(plan.batch[0].payload.edge_remap.length, 3)
  assert.equal(
    plan.batch.filter((item) => item.type === 'EDGE_ADDED').length,
    3,
  )
  assert.equal(plan.edgeRemap.length, 6)
})

test('split fans prerequisites into three children while sharing one terminal', () => {
  const plan = splitPlan(
    [
      { temp_id: 'left', title: 'Left', brief: 'Left.', estimate: 5, tags: [], deps: [] },
      { temp_id: 'right', title: 'Right', brief: 'Right.', estimate: 5, tags: [], deps: [] },
      { temp_id: 'join', title: 'Join', brief: 'Join.', estimate: 5, tags: [], deps: ['left', 'right'] },
    ],
    [
      { edge_id: 'incoming', upstream: 'before', downstream: 'parent', kind: 'depends' },
      { edge_id: 'outgoing', upstream: 'parent', downstream: 'after', kind: 'depends' },
    ],
  )

  assert.equal(plan.entryIds.length, 2)
  assert.equal(plan.terminalIds.length, 1)
  assert.deepEqual(
    plan.edgeRemap
      .filter((edge) => edge.upstream === 'before')
      .map((edge) => edge.downstream),
    plan.entryIds,
  )
  assert.deepEqual(
    plan.edgeRemap
      .filter((edge) => edge.downstream === 'after')
      .map((edge) => edge.upstream),
    plan.terminalIds,
  )
  assert.equal(plan.edgeRemap.length, 3)
  assert.equal(
    plan.batch.filter((item) => item.type === 'EDGE_ADDED').length,
    3,
  )
})
