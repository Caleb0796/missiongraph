import assert from 'node:assert/strict'
import test from 'node:test'

import {
  configuredServer,
  parseStoredIdentity,
  realtimeTransport,
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

test('persisted clone identities are validated and dead clones are replaceable', () => {
  assert.deepEqual(
    parseStoredIdentity('{"project":"visitor-project","token":"visitor-token"}'),
    { project: 'visitor-project', token: 'visitor-token' },
  )
  assert.equal(parseStoredIdentity('{"project":"visitor-project"}'), null)
  assert.equal(parseStoredIdentity('not-json'), null)
  assert.equal(shouldReplaceStoredIdentity('project_not_found'), true)
  assert.equal(shouldReplaceStoredIdentity('http_401'), true)
  assert.equal(shouldReplaceStoredIdentity('network_error'), false)
})

test('three websocket failures select the SSE fallback', () => {
  assert.equal(realtimeTransport(2), 'websocket')
  assert.equal(realtimeTransport(3), 'sse')
})
