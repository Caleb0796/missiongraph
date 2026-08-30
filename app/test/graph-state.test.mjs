import assert from 'node:assert/strict'
import test from 'node:test'

import {
  approvalsForNode,
  boundedHistory,
  eventTargetsNode,
  getBlastRadius,
  humanizeIdleAge,
  idleRadar,
  isPreviewStale,
  rankedPendingApprovals,
  refreshReadySince,
} from '../src/model/graph.ts'

const task = (id, state = 'queued', extra = {}) => ({
  id,
  title: `Task ${id}`,
  brief: `Complete ${id}.`,
  estimate_min: 5,
  tags: [],
  state,
  ...extra,
})

test('readiness timestamps follow every derived readiness transition', () => {
  const a = task('a')
  const b = task('b')
  const edge = {
    edge_id: 'a-b',
    upstream: 'a',
    downstream: 'b',
    kind: 'depends',
  }
  let ready = refreshReadySince([], [], [a, b], [], {}, '10:00')
  assert.deepEqual(ready, { a: '10:00', b: '10:00' })
  ready = refreshReadySince([a, b], [], [a, b], [edge], ready, '10:01')
  assert.deepEqual(ready, { a: '10:00' })
  ready = refreshReadySince(
    [a, b],
    [edge],
    [task('a', 'done', { assigned: true }), b],
    [edge],
    ready,
    '10:02',
  )
  assert.deepEqual(ready, { b: '10:02' })
})

test('blast radius includes downstream running work', () => {
  const nodes = [task('a'), task('b', 'running'), task('c')]
  const edges = [
    { edge_id: 'a-b', upstream: 'a', downstream: 'b', kind: 'depends' },
    { edge_id: 'b-c', upstream: 'b', downstream: 'c', kind: 'depends' },
  ]
  assert.deepEqual(getBlastRadius(['a'], nodes, edges), {
    stale: ['a', 'b', 'c'],
    pausing: ['b'],
  })
  assert.equal(isPreviewStale('12', '13'), true)
  assert.equal(isPreviewStale('13', '13'), false)
})

test('history is bounded and node dossiers include annotations and all approvals', () => {
  assert.deepEqual(
    boundedHistory(Array.from({ length: 205 }, (_, index) => ({ seq: index + 1 }))).map(
      (item) => item.seq,
    ),
    Array.from({ length: 200 }, (_, index) => index + 6),
  )
  const annotation = {
    seq: 4,
    project_id: 'project',
    ts: '2026-08-30T10:00:00.000Z',
    actor: 'human',
    type: 'ANNOTATED',
    payload: { target_id: 'a', note: 'Keep this rationale.' },
    idem_key: 'annotation',
  }
  assert.equal(eventTargetsNode(annotation, 'a'), true)
  assert.deepEqual(
    approvalsForNode(
      {
        later: {
          id: 'later',
          node_id: 'a',
          summary: 'Later review',
          created_at: '2026-08-30T10:02:00.000Z',
          created_seq: 8,
          status: 'approved',
        },
        earlier: {
          id: 'earlier',
          node_id: 'a',
          summary: 'Earlier review',
          created_at: '2026-08-30T10:01:00.000Z',
          created_seq: 5,
          status: 'rejected',
        },
      },
      'a',
    ).map((approval) => approval.id),
    ['earlier', 'later'],
  )
})

test('flight queues rank delay before age and radar humanizes oldest idle work', () => {
  const nodes = [
    task('old-ready', 'queued', { assigned: false, ever_started: false }),
    task('new-ready', 'queued', { assigned: false, ever_started: false }),
    task('long-review', 'review', { estimate_min: 20 }),
    task('short-review', 'review', { estimate_min: 5 }),
  ]
  const approvals = {
    short: {
      id: 'short',
      node_id: 'short-review',
      summary: 'Short review',
      created_at: '2026-08-30T10:00:00.000Z',
      created_seq: 1,
      status: 'pending',
    },
    long: {
      id: 'long',
      node_id: 'long-review',
      summary: 'Long review',
      created_at: '2026-08-30T10:05:00.000Z',
      created_seq: 2,
      status: 'pending',
    },
  }
  assert.deepEqual(
    rankedPendingApprovals(approvals, nodes, []).map((item) => item.id),
    ['long', 'short'],
  )
  const now = Date.parse('2026-08-30T11:00:00.000Z')
  const readySince = {
    'old-ready': '2026-08-30T10:20:00.000Z',
    'new-ready': '2026-08-30T10:55:00.000Z',
  }
  assert.deepEqual(
    idleRadar(nodes, [], readySince, now).map((item) => item.id),
    ['old-ready'],
  )
  assert.equal(humanizeIdleAge(readySince['old-ready'], now), 'idle 40m')
  assert.equal(humanizeIdleAge('17m', now), 'idle 17m')
})
