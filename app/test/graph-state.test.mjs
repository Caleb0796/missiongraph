import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeFailedNodes,
  annotationsForTarget,
  approvalQueueFromRanking,
  approvalsForNode,
  boundedHistory,
  contextualToolNamesForState,
  eventTargetsNode,
  fixtureRankedPendingApprovals,
  foldTaskSplit,
  getBlastRadius,
  humanizeIdleAge,
  idleRadar,
  isPreviewStale,
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
    stale: ['b'],
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
    fixtureRankedPendingApprovals(approvals, nodes, []).map((item) => item.id),
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

test('approval queue consumes server ranking instead of local path weight', () => {
  const approvals = {
    locallyLong: {
      id: 'locallyLong',
      node_id: 'long',
      summary: 'Locally long',
      created_at: '2026-08-30T10:00:00.000Z',
      created_seq: 1,
      status: 'pending',
    },
    serverFirst: {
      id: 'serverFirst',
      node_id: 'short',
      summary: 'Server says first',
      created_at: '2026-08-30T10:01:00.000Z',
      created_seq: 2,
      status: 'pending',
    },
  }
  const serverRanking = [
    {
      approval_id: 'serverFirst',
      node_id: 'short',
      node_title: 'Short',
      summary: 'Server says first',
      delay_impact_min: 90,
      age_since: '2026-08-30T10:01:00.000Z',
    },
    {
      approval_id: 'locallyLong',
      node_id: 'long',
      node_title: 'Long',
      summary: 'Locally long',
      delay_impact_min: 10,
      age_since: '2026-08-30T10:00:00.000Z',
    },
  ]
  assert.deepEqual(
    approvalQueueFromRanking(approvals, serverRanking).map((item) => [
      item.id,
      item.delayImpactMin,
    ]),
    [
      ['serverFirst', 90],
      ['locallyLong', 10],
    ],
  )
})

test('TASK_SPLIT fold remaps incident edges exactly and preserves durable lineage', () => {
  const nodes = [task('upstream', 'done'), task('parent'), task('downstream')]
  const edges = [
    {
      edge_id: 'incoming',
      upstream: 'upstream',
      downstream: 'parent',
      kind: 'depends',
    },
    {
      edge_id: 'outgoing',
      upstream: 'parent',
      downstream: 'downstream',
      kind: 'depends',
    },
    {
      edge_id: 'untouched',
      upstream: 'upstream',
      downstream: 'downstream',
      kind: 'conflicts',
    },
  ]
  const children = [task('entry'), task('terminal')]
  const folded = foldTaskSplit(nodes, edges, {
    parent_id: 'parent',
    children,
    edge_remap: [
      { edge_id: 'incoming', new_target: 'entry' },
      { edge_id: 'outgoing', new_target: 'terminal' },
    ],
  })
  assert.deepEqual(
    folded.edges.sort((left, right) => left.edge_id.localeCompare(right.edge_id)),
    [
      {
        edge_id: 'incoming',
        upstream: 'upstream',
        downstream: 'entry',
        kind: 'depends',
      },
      {
        edge_id: 'outgoing',
        upstream: 'terminal',
        downstream: 'downstream',
        kind: 'depends',
      },
      {
        edge_id: 'untouched',
        upstream: 'upstream',
        downstream: 'downstream',
        kind: 'conflicts',
      },
    ],
  )
  assert.equal(
    folded.nodes.find((node) => node.id === 'parent').record_type,
    'group',
  )
  assert.equal(
    folded.nodes.find((node) => node.id === 'entry').parent_id,
    'parent',
  )
  const cappedEvents = boundedHistory(
    Array.from({ length: 205 }, (_, index) => ({ seq: index + 1 })),
  )
  assert.equal(cappedEvents[0].seq, 6)
  assert.equal(
    folded.nodes.find((node) => node.id === 'entry').parent_id,
    'parent',
  )
})

test('edge dossiers follow remap annotation lineage and active failures exclude groups', () => {
  const inherited = {
    actor: 'human',
    note: 'Preserve this rationale.',
    ts: '2026-08-30T10:00:00.000Z',
  }
  const current = {
    actor: 'browser_agent',
    note: 'Annotated after remap.',
    ts: '2026-08-30T10:01:00.000Z',
  }
  assert.deepEqual(
    annotationsForTarget(
      { predecessor: [inherited], replacement: [current] },
      { replacement: ['predecessor'] },
      'replacement',
    ),
    [current, inherited],
  )
  assert.deepEqual(
    activeFailedNodes([
      task('failed-child', 'failed'),
      task('failed-parent', 'failed', { record_type: 'group' }),
      task('done', 'done'),
    ]).map((node) => node.id),
    ['failed-child'],
  )
  assert.deepEqual(
    activeFailedNodes([
      task('failed-parent', 'failed', { record_type: 'group' }),
    ]),
    [],
  )
})

test('splitting the last failed task unregisters failure and selection aliases', () => {
  const failed = task('failed', 'failed')
  assert.ok(
    contextualToolNamesForState([failed], [], 'failed').includes(
      'review_failures',
    ),
  )
  const folded = foldTaskSplit([failed], [], {
    parent_id: 'failed',
    children: [task('retry-a'), task('retry-b')],
    edge_remap: [],
  })
  assert.deepEqual(
    contextualToolNamesForState(folded.nodes, folded.edges, 'failed'),
    [],
  )
})
