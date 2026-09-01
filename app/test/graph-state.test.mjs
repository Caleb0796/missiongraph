import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeFailedNodes,
  approvalQueueFromRanking,
  approvalsForNode,
  boundedHistory,
  contextualToolNamesForState,
  describeEvent,
  eventTargetsNode,
  fixtureRankedPendingApprovals,
  foldEdgeLineage,
  foldTaskSplit,
  getBlastRadius,
  humanizeIdleAge,
  idleRadar,
  isPreviewStale,
  pruneEdgeLineage,
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

test('visitor clone detach events explain why recorded workers are paused', () => {
  const nodes = [task('a', 'paused')]
  const detached = {
    seq: 1,
    project_id: 'project',
    ts: '2026-09-01T10:00:00.000Z',
    actor: 'supervisor',
    type: 'NODE_STATE_CHANGED',
    payload: {
      node_id: 'a',
      from: 'running',
      to: 'paused',
      detail: 'worker detached during visitor clone',
    },
    idem_key: 'detached',
  }
  assert.equal(
    describeEvent(detached, nodes, []),
    'Recorded worker detached when your private mission copy was created',
  )
  assert.equal(
    describeEvent(
      {
        ...detached,
        payload: { node_id: 'a', from: 'running', to: 'paused' },
      },
      nodes,
      [],
    ),
    'Task a moved from running to paused.',
  )
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

test('active failures exclude retired split parents', () => {
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

test('stable edge remaps retain annotations recorded before and after a split', () => {
  const edge = {
    edge_id: 'parent-successor',
    upstream: 'parent',
    downstream: 'successor',
    kind: 'depends',
  }
  const folded = foldTaskSplit(
    [task('parent'), task('successor')],
    [edge],
    {
      parent_id: 'parent',
      children: [task('entry'), task('terminal')],
      edge_remap: [{ edge_id: edge.edge_id, new_target: 'terminal' }],
    },
  )
  const annotations = {
    [edge.edge_id]: [
      {
        actor: 'human',
        note: 'Preserve this rationale.',
        ts: '2026-08-30T10:00:00.000Z',
      },
    ],
  }
  const remapped = folded.edges.find(
    (candidate) => candidate.edge_id === edge.edge_id,
  )
  assert.deepEqual(remapped, {
    ...edge,
    upstream: 'terminal',
  })
  annotations[remapped.edge_id].push({
    actor: 'browser_agent',
    note: 'Annotated after remap.',
    ts: '2026-08-30T10:01:00.000Z',
  })
  assert.deepEqual(
    annotations[remapped.edge_id].map((annotation) => annotation.note),
    ['Preserve this rationale.', 'Annotated after remap.'],
  )
})

test('edge lineage rebuilds from split folds, prunes removals, and evicts oldest entries', () => {
  const parent = task('parent', 'queued', {
    record_type: 'group',
    child_ids: ['entry', 'terminal'],
  })
  const nodes = [
    task('upstream'),
    parent,
    task('entry', 'queued', { parent_id: 'parent' }),
    task('terminal', 'queued', { parent_id: 'parent' }),
  ]
  const remapped = {
    edge_id: 'incoming',
    upstream: 'upstream',
    downstream: 'entry',
    kind: 'depends',
  }
  let lineage = foldEdgeLineage(
    {},
    {
      seq: 10,
      project_id: 'project',
      ts: '2026-08-30T10:00:00.000Z',
      actor: 'human',
      type: 'TASK_SPLIT',
      payload: {
        parent_id: 'parent',
        children: [task('entry'), task('terminal')],
        edge_remap: [{ edge_id: 'incoming', new_target: 'entry' }],
      },
      idem_key: 'split',
    },
    nodes,
    [remapped],
  )
  assert.deepEqual(lineage, { incoming: { parent_id: 'parent', seq: 10 } })

  const internal = {
    edge_id: 'internal',
    upstream: 'entry',
    downstream: 'terminal',
    kind: 'depends',
  }
  lineage = foldEdgeLineage(
    lineage,
    {
      seq: 11,
      project_id: 'project',
      ts: '2026-08-30T10:00:01.000Z',
      actor: 'human',
      type: 'EDGE_ADDED',
      payload: internal,
      idem_key: 'internal',
    },
    nodes,
    [remapped, internal],
  )
  assert.deepEqual(lineage.internal, { parent_id: 'parent', seq: 11 })
  assert.deepEqual(lineage, {
    incoming: { parent_id: 'parent', seq: 10 },
    internal: { parent_id: 'parent', seq: 11 },
  })

  lineage = foldEdgeLineage(
    lineage,
    {
      seq: 12,
      project_id: 'project',
      ts: '2026-08-30T10:00:02.000Z',
      actor: 'human',
      type: 'EDGE_REMOVED',
      payload: { edge_id: 'incoming' },
      idem_key: 'remove',
    },
    nodes,
    [internal],
  )
  assert.deepEqual(lineage, { internal: { parent_id: 'parent', seq: 11 } })

  const manyEdges = Array.from({ length: 501 }, (_, index) => ({
    edge_id: `edge-${String(index).padStart(3, '0')}`,
    upstream: 'entry',
    downstream: 'terminal',
    kind: 'depends',
  }))
  const bounded = pruneEdgeLineage(
    Object.fromEntries(
      manyEdges.map((edge, index) => [
        edge.edge_id,
        { parent_id: 'parent', seq: index },
      ]),
    ),
    nodes,
    manyEdges,
  )
  assert.equal(Object.keys(bounded).length, 500)
  assert.equal(bounded['edge-000'], undefined)
  assert.deepEqual(bounded['edge-500'], { parent_id: 'parent', seq: 500 })
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
