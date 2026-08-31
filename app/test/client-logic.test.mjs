import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bootstrapRetryDelay,
  clockSampleIsFresh,
  claimFirstRunPrompts,
  connectionProvedStable,
  configuredServer,
  copyText,
  digestRetryDelay,
  dismissFirstRunPrompts,
  estimateClockSkew,
  eventBelongsToProject,
  identityFailureDisposition,
  mutationEpochMatches,
  parseStoredIdentity,
  reconnectDelay,
  realtimeTransport,
  recoverSequenceAfterSnapshot,
  safeDigestMetadata,
  sequenceDisposition,
  shouldApplyDigest,
  shouldApplySnapshot,
  skewCorrectedNow,
  toolCursorForProject,
} from '../src/transport/client-logic.ts'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

test('production uses only an absolute configured API URL', () => {
  assert.deepEqual(configuredServer('https://api.example.test/', false), {
    logicalServer: 'https://api.example.test',
    requestBase: 'https://api.example.test',
  })
  assert.deepEqual(configuredServer(undefined, false), {
    logicalServer: null,
    requestBase: null,
  })
  assert.throws(() => configuredServer('file:///tmp/server', false))
})

test('foreign-link 404 preserves the stored identity and uses HTTP status', () => {
  assert.deepEqual(
    parseStoredIdentity('{"project":"visitor-project","token":"visitor-token"}'),
    { project: 'visitor-project', token: 'visitor-token' },
  )
  assert.equal(parseStoredIdentity('{"project":"visitor-project"}'), null)
  assert.equal(parseStoredIdentity('not-json'), null)
  assert.equal(identityFailureDisposition('url', 404), 'invalid-link')
  assert.equal(identityFailureDisposition('url', 401), 'invalid-link')
  assert.equal(identityFailureDisposition('url', undefined), 'retry')
  assert.equal(identityFailureDisposition('stored', 404), 'replace-stored')
  assert.equal(identityFailureDisposition('stored', undefined), 'retry')
})

test('tool envelope changes expose safe policy authorization metadata only', () => {
  const policyEvent = {
    seq: 5,
    project_id: 'project',
    ts: '2026-08-30T10:05:00.000Z',
    actor: 'human',
    type: 'POLICY_STATED',
    payload: {
      policy_ref: 'policy-a',
      text: 'Approve green diffs.',
      scope: 'session',
      session_id: 'session-a',
      capability: 'must-not-escape',
    },
    idem_key: 'policy-a',
  }
  const policyChange = {
    seq: policyEvent.seq,
    actor: policyEvent.actor,
    type: policyEvent.type,
    one_liner: 'Human stated an approval policy: Approve green diffs.',
    ...safeDigestMetadata(policyEvent),
  }
  const policyRefReadByAgent = policyChange.policy_ref
  const approvedEvent = {
    seq: 6,
    project_id: 'project',
    ts: '2026-08-30T10:05:01.000Z',
    actor: 'browser_agent',
    type: 'APPROVED',
    payload: {
      approval_id: 'approval-a',
      node_id: 'a',
      policy_ref: policyRefReadByAgent,
      authorization: {
        capability_ref: 'policy-a',
        confirmed_at: policyEvent.ts,
        request_origin: 'https://missiongraph.vercel.app',
        use_nonce: 'approval-use-a',
        capability: 'must-not-escape',
      },
    },
    idem_key: 'approved-a',
  }
  const approvedChange = {
    seq: approvedEvent.seq,
    actor: approvedEvent.actor,
    type: approvedEvent.type,
    one_liner: 'Browser agent approved Task a.',
    ...safeDigestMetadata(approvedEvent),
  }
  const envelope = {
    ok: true,
    cursor: '6',
    changes_since: [policyChange, approvedChange],
  }

  assert.equal(policyRefReadByAgent, 'policy-a')
  assert.deepEqual(envelope.changes_since[1].authorization, {
    capability_ref: 'policy-a',
    use_nonce: 'approval-use-a',
  })
  assert.doesNotMatch(JSON.stringify(envelope), /must-not-escape/)
})

test('snapshot fallback replays the mutation event from its captured cursor once', async () => {
  let cursor = '5'
  const changes = []
  const record = (event) => {
    if (!changes.some((change) => change.seq === event.seq)) changes.push(event)
  }

  await recoverSequenceAfterSnapshot(
    '5',
    async () => {
      cursor = '6'
    },
    async (since) => {
      assert.equal(since, '5')
      assert.equal(cursor, '6')
      record({ seq: 6, type: 'APPROVED' })
      record({ seq: 6, type: 'APPROVED' })
    },
  )

  assert.deepEqual(changes, [{ seq: 6, type: 'APPROVED' }])
})

test('cross-project events and stale same-project snapshots are rejected', () => {
  assert.equal(eventBelongsToProject('project-a', 'project-b'), false)
  assert.equal(eventBelongsToProject('project-a', 'project-a'), true)
  assert.equal(shouldApplySnapshot('project-a', '42', 'project-a', '41'), false)
  assert.equal(shouldApplySnapshot('project-a', '42', 'project-a', '42'), true)
  assert.equal(shouldApplySnapshot('project-a', '42', 'project-b', '1'), true)
})

test('digest folds and mutation epochs reject foreign project context', () => {
  assert.equal(shouldApplyDigest('project-b', '48', 'project-a', '100'), false)
  assert.equal(shouldApplyDigest('project-b', '48', 'project-b', '47'), false)
  assert.equal(shouldApplyDigest('project-b', '48', 'project-b', '49'), true)
  assert.equal(mutationEpochMatches(7, 'project-a', 8, 'project-b'), false)
  assert.equal(mutationEpochMatches(7, 'project-a', 7, 'project-b'), false)
  assert.equal(mutationEpochMatches(7, 'project-a', 7, 'project-a'), true)
})

test('WebMCP cursor restarts history at zero after a project switch', () => {
  const previous = { projectId: 'project-a', cursor: '100' }
  assert.equal(toolCursorForProject(previous, 'project-b', '48'), '0')
  assert.equal(toolCursorForProject(previous, 'project-a', '101'), '100')
  assert.equal(toolCursorForProject(null, 'project-b', '48'), '48')
})

test('first-run prompts appear once and dismissal stays project-scoped', () => {
  const storage = memoryStorage()
  assert.equal(claimFirstRunPrompts('project-a', storage), true)
  assert.equal(claimFirstRunPrompts('project-a', storage), false)
  assert.equal(claimFirstRunPrompts('project-b', storage), true)
  dismissFirstRunPrompts('project-a', storage)
  assert.equal(claimFirstRunPrompts('project-a', storage), false)
})

test('clipboard denial falls back to a temporary execCommand control', async () => {
  const calls = []
  const textarea = {
    value: '',
    style: {},
    setAttribute: (...args) => calls.push(['attribute', ...args]),
    select: () => calls.push(['select']),
    remove: () => calls.push(['remove']),
  }
  const copied = await copyText(
    'Ask your agent',
    {
      writeText: async () => {
        throw new Error('denied')
      },
    },
    {
      body: { append: (element) => calls.push(['append', element]) },
      createElement: () => textarea,
      execCommand: (command) => {
        calls.push(['execCommand', command])
        return true
      },
    },
  )
  assert.equal(copied, true)
  assert.equal(textarea.value, 'Ask your agent')
  assert.deepEqual(
    calls.map(([name]) => name),
    ['attribute', 'append', 'select', 'execCommand', 'remove'],
  )
})

test('copy helper reports the manual fallback when both browser paths fail', async () => {
  const textarea = {
    value: '',
    style: {},
    setAttribute: () => {},
    select: () => {},
    remove: () => {},
  }
  const copied = await copyText(
    'Ask your agent',
    {
      writeText: async () => {
        throw new Error('denied')
      },
    },
    {
      body: { append: () => {} },
      createElement: () => textarea,
      execCommand: () => false,
    },
  )
  assert.equal(copied, false)
})

test('websocket drops back off with jitter and retain SSE resume semantics', () => {
  assert.equal(realtimeTransport(2), 'websocket')
  assert.equal(realtimeTransport(3), 'sse')
  assert.equal(reconnectDelay(0, () => 0.5), 500)
  assert.equal(reconnectDelay(3, () => 0.5), 4_000)
  assert.equal(reconnectDelay(12, () => 0.5), 30_000)
  assert.equal(sequenceDisposition('14', 14), 'duplicate')
  assert.equal(sequenceDisposition('14', 15), 'next')
  assert.equal(sequenceDisposition('14', 17), 'gap')
  assert.equal(connectionProvedStable(0, 29_999, false), false)
  assert.equal(connectionProvedStable(0, 30_000, false), true)
  assert.equal(connectionProvedStable(0, 1, true), true)
})

test('bootstrap retry and server-clock correction follow the recovery schedule', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 9].map(bootstrapRetryDelay),
    [5_000, 15_000, 30_000, 60_000, 60_000],
  )
  const localReceipt = Date.parse('2026-08-30T09:00:00.000Z')
  const skew = estimateClockSkew('2026-08-30T10:00:00.000Z', localReceipt)
  assert.equal(skew, 60 * 60_000)
  assert.equal(
    skewCorrectedNow(localReceipt, skew),
    Date.parse('2026-08-30T10:00:00.000Z'),
  )
  assert.equal(estimateClockSkew('2026-09-01T10:00:00.000Z', localReceipt), 0)
  assert.equal(clockSampleIsFresh(localReceipt, localReceipt + 60_000), true)
  assert.equal(clockSampleIsFresh(localReceipt, localReceipt + 6 * 60_000), false)
  assert.deepEqual(
    [0, 1, 2, 3, 4].map(digestRetryDelay),
    [500, 1_500, 5_000, 15_000, null],
  )
})
