import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bootstrapRetryDelay,
  clockSampleIsFresh,
  connectionProvedStable,
  configuredServer,
  digestRetryDelay,
  estimateClockSkew,
  eventBelongsToProject,
  identityFailureDisposition,
  mutationEpochMatches,
  parseStoredIdentity,
  reconnectDelay,
  realtimeTransport,
  sequenceDisposition,
  shouldApplyDigest,
  shouldApplySnapshot,
  skewCorrectedNow,
  toolCursorForProject,
} from '../src/transport/client-logic.ts'

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
