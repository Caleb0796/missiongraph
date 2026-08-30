import assert from 'node:assert/strict'
import test from 'node:test'

import {
  configuredServer,
  parseStoredIdentity,
  reconnectDelay,
  realtimeTransport,
  sequenceDisposition,
  shouldReplaceStoredIdentity,
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

test('expired stored identities are recognized for automatic replacement', () => {
  assert.deepEqual(
    parseStoredIdentity('{"project":"visitor-project","token":"visitor-token"}'),
    { project: 'visitor-project', token: 'visitor-token' },
  )
  assert.equal(parseStoredIdentity('{"project":"visitor-project"}'), null)
  assert.equal(parseStoredIdentity('not-json'), null)
  assert.equal(shouldReplaceStoredIdentity('project_not_found'), true)
  assert.equal(shouldReplaceStoredIdentity('http_401'), true)
  assert.equal(shouldReplaceStoredIdentity('http_404'), true)
  assert.equal(shouldReplaceStoredIdentity('network_error'), false)
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
})
