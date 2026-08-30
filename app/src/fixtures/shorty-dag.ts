import type {
  Ev,
  EventPayloadMap,
  EvType,
  GraphEdge,
  Handoff,
  MissionEvent,
  NodeState,
  TaskNode,
} from '../model/types'

export interface ApprovalFixture {
  id: string
  node_id: string
  summary: string
  risk: 'routine' | 'schema'
  age_min: number
}

const PROJECT_ID = 'shorty-demo'
const STARTED_AT = Date.parse('2026-08-30T16:04:00.000Z')

const taskRows: {
  id: string
  title: string
  brief: string
  estimate_min: number
  tags: string[]
  state: NodeState
}[] = [
  {
    id: 'T01',
    title: 'Rate-limit link creation',
    brief: 'Add configurable per-IP limits to POST /api/links.',
    estimate_min: 12,
    tags: ['api', 'security'],
    state: 'running',
  },
  {
    id: 'T02',
    title: 'Block unsafe destinations',
    brief: 'Reject localhost, private-network, and non-public destination hosts.',
    estimate_min: 15,
    tags: ['security', 'validation'],
    state: 'done',
  },
  {
    id: 'T03',
    title: 'Generate OpenAPI docs',
    brief: 'Add route schemas and expose interactive API documentation.',
    estimate_min: 18,
    tags: ['docs', 'api'],
    state: 'queued',
  },
  {
    id: 'T04',
    title: 'Cache hot redirects',
    brief: 'Add a bounded in-memory cache while preserving accurate hit counts.',
    estimate_min: 15,
    tags: ['performance', 'redirects'],
    state: 'done',
  },
  {
    id: 'T05',
    title: 'Add link expiry',
    brief: 'Accept an optional expiry and return 410 after it passes.',
    estimate_min: 20,
    tags: ['api', 'storage'],
    state: 'review',
  },
  {
    id: 'T06',
    title: 'Add visit analytics',
    brief: 'Persist timestamped visits and expose daily counts for a slug.',
    estimate_min: 25,
    tags: ['analytics', 'schema'],
    state: 'review',
  },
  {
    id: 'T07',
    title: 'Batch hit-count writes',
    brief: 'Buffer redirect hits and flush them transactionally.',
    estimate_min: 20,
    tags: ['performance', 'storage'],
    state: 'failed',
  },
  {
    id: 'T08',
    title: 'Add link deletion',
    brief: 'Implement DELETE /api/links/:slug with storage support and tests.',
    estimate_min: 12,
    tags: ['api', 'storage'],
    state: 'done',
  },
  {
    id: 'T09',
    title: 'Add link listing',
    brief: 'Implement paginated GET /api/links ordered by creation time.',
    estimate_min: 15,
    tags: ['api', 'pagination'],
    state: 'queued',
  },
  {
    id: 'T10',
    title: 'Support idempotency keys',
    brief: 'Make repeated create requests return the original short link.',
    estimate_min: 18,
    tags: ['api', 'reliability'],
    state: 'running',
  },
  {
    id: 'T11',
    title: 'Add structured request logs',
    brief: 'Enable Fastify logs and attach a request ID to responses.',
    estimate_min: 10,
    tags: ['observability'],
    state: 'review',
  },
  {
    id: 'T12',
    title: 'Add health endpoints',
    brief: 'Expose liveness and SQLite readiness checks.',
    estimate_min: 10,
    tags: ['operations'],
    state: 'review',
  },
  {
    id: 'T13',
    title: 'Containerize the service',
    brief: 'Add a production multi-stage container build and health check.',
    estimate_min: 15,
    tags: ['deployment'],
    state: 'queued',
  },
  {
    id: 'T14',
    title: 'Add analytics dashboard data',
    brief: 'Return top links and seven-day traffic for a small dashboard.',
    estimate_min: 20,
    tags: ['analytics', 'api'],
    state: 'queued',
  },
]

export const shortyNodes: TaskNode[] = taskRows.map((task) => ({ ...task }))

const depends: [string, string][] = [
  ['T12', 'T13'],
  ['T06', 'T14'],
  ['T09', 'T14'],
]

const conflicts: [string, string][] = [
  ['T01', 'T03'],
  ['T02', 'T05'],
  ['T03', 'T05'],
  ['T04', 'T07'],
  ['T05', 'T07'],
  ['T06', 'T07'],
  ['T06', 'T09'],
  ['T08', 'T09'],
  ['T01', 'T10'],
  ['T05', 'T10'],
  ['T01', 'T11'],
  ['T03', 'T11'],
  ['T03', 'T12'],
  ['T06', 'T14'],
  ['T09', 'T14'],
]

export const shortyEdges: GraphEdge[] = [
  ...depends.map(([upstream, downstream]) => ({
    edge_id: `depends-${upstream}-${downstream}`,
    upstream,
    downstream,
    kind: 'depends' as const,
  })),
  ...conflicts.map(([upstream, downstream]) => ({
    edge_id: `conflicts-${upstream}-${downstream}`,
    upstream,
    downstream,
    kind: 'conflicts' as const,
  })),
]

export const shortyApprovals: ApprovalFixture[] = [
  {
    id: 'approval-expiry',
    node_id: 'T05',
    summary: 'Expiry behavior is covered by focused route tests; 42 changed lines.',
    risk: 'routine',
    age_min: 18,
  },
  {
    id: 'approval-analytics-schema',
    node_id: 'T06',
    summary: 'Visit analytics adds a new SQLite visits table and migration path.',
    risk: 'schema',
    age_min: 31,
  },
  {
    id: 'approval-logs',
    node_id: 'T11',
    summary: 'Request IDs and structured logging pass the focused test suite; 29 changed lines.',
    risk: 'routine',
    age_min: 12,
  },
  {
    id: 'approval-health',
    node_id: 'T12',
    summary: 'Liveness and readiness routes are green; 34 changed lines.',
    risk: 'routine',
    age_min: 9,
  },
]

const handoffs: Record<string, Handoff> = {
  T02: {
    v: 1,
    summary:
      'Unsafe destination filtering now rejects loopback, private, link-local, and unresolved hosts before a link is stored.',
    files: ['src/routes/links.ts', 'src/security/destinations.ts'],
    commits: ['8d2f4a1'],
    tests: 'green',
    downstream_notes:
      'Route work can rely on validation returning a human-readable public-host error.',
    deviations: [],
    artifacts: [{ label: 'Validation test report', url: '#validation-tests' }],
  },
  T04: {
    v: 1,
    summary:
      'Redirect reads now use a bounded least-recently-used cache while hit counters still flow through storage.',
    files: ['src/routes/redirect.ts', 'src/cache.ts'],
    commits: ['22ae710'],
    tests: 'green',
    downstream_notes:
      'Batching work should keep the cache write-through hook intact when changing hit accounting.',
    deviations: ['The cache was kept process-local to avoid introducing a new service.'],
    artifacts: [],
  },
  T08: {
    v: 1,
    summary:
      'The deletion endpoint removes a link atomically and returns a clear not-found response for unknown slugs.',
    files: ['src/routes/links.ts', 'src/storage.ts', 'test/links.test.ts'],
    commits: ['bc91dc3'],
    tests: 'green',
    downstream_notes:
      'Listing work should reuse the exported storage transaction helper rather than opening another connection.',
    deviations: [],
    artifacts: [],
  },
}

function fixtureEvent<T extends EvType>(
  type: T,
  payload: EventPayloadMap[T],
  actor: Ev<T, EventPayloadMap[T]>['actor'] = 'supervisor',
): Ev<T, EventPayloadMap[T]> {
  const seq = eventSequence++

  return {
    seq,
    project_id: PROJECT_ID,
    ts: new Date(STARTED_AT + seq * 94_000).toISOString(),
    actor,
    type,
    payload,
    idem_key: `fixture-${seq.toString().padStart(3, '0')}`,
  }
}

let eventSequence = 1

const taskEvents: MissionEvent[] = shortyNodes.map((node) =>
  fixtureEvent('TASK_ADDED', { node }),
)
const edgeEvents: MissionEvent[] = shortyEdges.map((edge) =>
  fixtureEvent('EDGE_ADDED', edge),
)
const handoffEvents: MissionEvent[] = Object.entries(handoffs).map(
  ([node_id, handoff]) =>
    fixtureEvent('HANDOFF_FILED', { node_id, handoff }, `worker:${node_id}`),
)
const approvalEvents: MissionEvent[] = shortyApprovals.map((approval) =>
  fixtureEvent(
    'APPROVAL_CREATED',
    {
      approval_id: approval.id,
      node_id: approval.node_id,
      summary: approval.summary,
      diff_stats:
        approval.risk === 'schema'
          ? {
              lines_added: 91,
              lines_removed: 8,
              files: ['src/storage.ts', 'src/routes/analytics.ts'],
            }
          : undefined,
      tests: 'green',
    },
    `worker:${approval.node_id}`,
  ),
)

export const shortyEvents: MissionEvent[] = [
  ...taskEvents,
  ...edgeEvents,
  ...handoffEvents,
  fixtureEvent('DEVIATION_NOTED', {
    node_id: 'T07',
    kind: 'estimate',
    text: 'The flush transaction exposed a lock-order problem under concurrent redirects; the first retry was exhausted.',
    est_min: 20,
    actual_min: 34,
  }, 'worker:T07'),
  fixtureEvent('WORKER_LOG', {
    node_id: 'T01',
    lines: [
      'Added the per-IP token bucket around link creation.',
      'Running route tests with the limiter clock pinned.',
    ],
  }, 'worker:T01'),
  fixtureEvent('WORKER_LOG', {
    node_id: 'T07',
    lines: [
      'Concurrent flush test reproduced the busy transaction.',
      'Stopped after the guided retry still inverted the lock order.',
    ],
  }, 'worker:T07'),
  fixtureEvent('WORKER_LOG', {
    node_id: 'T10',
    lines: [
      'Persisting request keys beside the original short-link response.',
      'Replay coverage is passing; checking expiry interaction next.',
    ],
  }, 'worker:T10'),
  ...approvalEvents,
  fixtureEvent('ANNOTATED', {
    target_id: 'depends-T06-T14',
    note: 'Dashboard aggregates depend on the daily visit records introduced by analytics.',
  }, 'human'),
  fixtureEvent('ANNOTATED', {
    target_id: 'conflicts-T01-T03',
    note: 'Both branches edit route registration in the Fastify application shell.',
  }, 'browser_agent'),
  fixtureEvent('JOURNAL_NOTE', {
    text: 'Three small green changes may be cleared under the demo policy; database schema work remains a human exception.',
  }, 'human'),
  fixtureEvent('JOURNAL_NOTE', {
    text: 'The analytics-to-dashboard branch is the longest remaining route through the project.',
  }, 'supervisor'),
]

export const shortyReadySince: Record<string, string> = {
  T03: '40m',
  T09: '17m',
}
