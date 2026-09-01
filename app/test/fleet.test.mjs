import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LIVE_FLEET_BUSY_COPY,
  LiveFleetCoordinator,
  liveFleetDisplayText,
  withFleetMetadata,
} from '../src/transport/fleet.ts'

const enabled = {
  enabled: true,
  queue_depth: 2,
  daily_remaining: 20,
  project_remaining: 1,
}

function fakeTimers() {
  let nextId = 0
  const pending = new Map()
  const delays = []
  return {
    schedule(callback, milliseconds) {
      const id = ++nextId
      pending.set(id, callback)
      delays.push(milliseconds)
      return id
    },
    cancel(id) {
      pending.delete(id)
    },
    async runNext() {
      const [id, callback] = pending.entries().next().value ?? []
      if (!callback) return
      pending.delete(id)
      callback()
      await Promise.resolve()
      await Promise.resolve()
    },
    get size() {
      return pending.size
    },
    delays,
  }
}

function harness(overrides = {}) {
  const calls = []
  const displays = []
  const timers = fakeTimers()
  const transport = {
    status: async (session) => {
      calls.push(['status', session.project, session.sessionId])
      return enabled
    },
    create: async (_session, nodeId) => {
      calls.push(['create', nodeId])
      return { id: `request-${nodeId}`, status: 'queued', position: 3 }
    },
    get: async (_session, requestId) => {
      calls.push(['get', requestId])
      return { id: requestId, status: 'queued', position: 2 }
    },
    ...overrides,
  }
  const coordinator = new LiveFleetCoordinator({
    transport,
    onDisplay: (display) => displays.push(display),
    schedule: timers.schedule,
    cancel: timers.cancel,
  })
  coordinator.activate({ project: 'project-a', token: 'token-a', sessionId: 'session-a' })
  return { calls, coordinator, displays, timers }
}

test('fleet-enabled dispatch probes status, creates the request, and returns metadata', async () => {
  const { calls, coordinator, displays, timers } = harness()

  assert.deepEqual(await coordinator.dispatch('node-a'), {
    status: 'queued',
    position: 3,
  })
  assert.deepEqual(calls, [
    ['status', 'project-a', 'session-a'],
    ['create', 'node-a'],
  ])
  assert.deepEqual(displays.at(-1), {
    nodeId: 'node-a',
    phase: 'queued',
    position: 3,
  })
  assert.deepEqual(timers.delays, [10_000])
})

test('fleet-disabled dispatch is byte-compatible and caches the probe per session', async () => {
  const { calls, coordinator } = harness({
    status: async (session) => {
      calls.push(['status', session.project, session.sessionId])
      return { ...enabled, enabled: false }
    },
  })
  const current = {
    summary: 'Dispatched “Task” to the Codex supervisor.',
    node_id: 'node-a',
    bypass_cap: true,
  }
  const before = JSON.stringify(current)

  const first = await coordinator.dispatch('node-a')
  const second = await coordinator.dispatch('node-b')
  const result = withFleetMetadata(current, first)

  assert.equal(first, null)
  assert.equal(second, null)
  assert.equal(result, current)
  assert.equal(JSON.stringify(result), before)
  assert.deepEqual(calls, [['status', 'project-a', 'session-a']])
})

test('a hanging fleet probe cannot delay or change the dispatch tool result', () => {
  const { coordinator } = harness({
    status: () => new Promise(() => {}),
  })
  const current = {
    summary: 'Dispatched “Task” to the Codex supervisor.',
    node_id: 'node-a',
    bypass_cap: true,
  }
  const before = JSON.stringify(current)

  void coordinator.dispatch('node-a')
  const result = withFleetMetadata(
    current,
    coordinator.resultForDispatch('node-a'),
  )

  assert.equal(result, current)
  assert.equal(JSON.stringify(result), before)
})

test('fleet metadata is appended only when a request was created', () => {
  const data = { summary: 'dispatch succeeded', node_id: 'node-a' }
  assert.deepEqual(withFleetMetadata(data, { status: 'queued', position: 4 }), {
    summary: 'dispatch succeeded',
    node_id: 'node-a',
    fleet: { status: 'queued', position: 4 },
  })
  assert.equal(withFleetMetadata(data, null), data)
})

test('enqueue errors resolve without failing dispatch and show one honest line', async () => {
  const displays = []
  const direct = new LiveFleetCoordinator({
    transport: {
      status: async () => enabled,
      create: async () => {
        throw Object.assign(
          new Error('The fleet has reached its daily request cap.'),
          { code: 'fleet_daily_cap' },
        )
      },
      get: async () => {
        throw new Error('not reached')
      },
    },
    onDisplay: (display) => displays.push(display),
  })
  direct.activate({ project: 'project-a', token: 'token-a', sessionId: 'session-a' })

  assert.deepEqual(await direct.dispatch('node-a'), {
    status: 'rejected',
    error: {
      code: 'fleet_daily_cap',
      reason: 'The fleet has reached its daily request cap.',
    },
  })
  assert.deepEqual(await direct.dispatch('node-b'), {
    status: 'rejected',
    error: {
      code: 'fleet_daily_cap',
      reason: 'The fleet has reached its daily request cap.',
    },
  })
  assert.deepEqual(displays.filter(Boolean), [
    {
      nodeId: 'node-a',
      phase: 'degraded',
      error: {
        code: 'fleet_daily_cap',
        reason: 'The fleet has reached its daily request cap.',
      },
    },
  ])
  assert.match(liveFleetDisplayText(displays.at(-1)), /capacity unavailable/i)
})

test('template mismatch stays non-failing but is explicit in tool data and UI copy', async () => {
  const reason = 'This dispatched task does not match the fleet template.'
  const { coordinator, displays } = harness({
    create: async () => {
      throw Object.assign(new Error(reason), { code: 'template_mismatch' })
    },
  })
  const current = {
    summary: 'Dispatched “Task” to the Codex supervisor.',
    node_id: 'node-a',
    bypass_cap: true,
  }

  await coordinator.dispatch('node-a')
  const result = withFleetMetadata(
    current,
    coordinator.resultForDispatch('node-a'),
  )
  const copy = liveFleetDisplayText(displays.at(-1))

  assert.deepEqual(result, {
    ...current,
    fleet: {
      status: 'rejected',
      error: { code: 'template_mismatch', reason },
    },
  })
  assert.match(copy, /not eligible/i)
  assert.match(copy, /template_mismatch/)
  assert.doesNotMatch(copy, /busy/i)
})

test('polling maps adopted and running states to worker starting every 10 seconds', async () => {
  const statuses = ['adopted', 'running']
  const { coordinator, displays, timers } = harness({
    get: async (_session, requestId) => ({
      id: requestId,
      status: statuses.shift(),
    }),
  })
  await coordinator.dispatch('node-a')

  await timers.runNext()
  assert.equal(liveFleetDisplayText(displays.at(-1)), 'Live fleet: worker starting')
  assert.equal(timers.size, 1)
  await timers.runNext()
  assert.equal(liveFleetDisplayText(displays.at(-1)), 'Live fleet: worker starting')
  assert.deepEqual(timers.delays, [10_000, 10_000, 10_000])
})

test('polling stops and removes the status on done', async () => {
  const { coordinator, displays, timers } = harness({
    get: async (_session, requestId) => ({ id: requestId, status: 'done' }),
  })
  await coordinator.dispatch('node-a')

  await timers.runNext()

  assert.equal(displays.at(-1), null)
  assert.equal(timers.size, 0)
})

test('failed and expired requests stop polling with the honest degradation line', async (t) => {
  for (const status of ['failed', 'expired']) {
    await t.test(status, async () => {
      const { coordinator, displays, timers } = harness({
        get: async (_session, requestId) => ({ id: requestId, status }),
      })
      await coordinator.dispatch('node-a')
      await timers.runNext()

      assert.equal(liveFleetDisplayText(displays.at(-1)), LIVE_FLEET_BUSY_COPY)
      assert.equal(timers.size, 0)
    })
  }
})

test('project switch cancels fleet polling and clears the old project status', async () => {
  const { coordinator, displays, timers } = harness()
  await coordinator.dispatch('node-a')
  assert.equal(timers.size, 1)

  coordinator.activate({ project: 'project-b', token: 'token-b', sessionId: 'session-b' })

  assert.equal(timers.size, 0)
  assert.equal(displays.at(-1), null)
})

test('stale in-flight fleet responses are ignored after a project switch', async () => {
  let resolveStatus
  const { calls, coordinator, displays } = harness({
    status: () =>
      new Promise((resolve) => {
        resolveStatus = resolve
      }),
  })
  const pending = coordinator.dispatch('node-a')

  coordinator.activate({ project: 'project-b', token: 'token-b', sessionId: 'session-b' })
  resolveStatus(enabled)
  await pending

  assert.deepEqual(calls, [])
  assert.equal(coordinator.resultForDispatch('node-a'), null)
  assert.equal(displays.at(-1), null)
})

test('worker ledger events remove fleet narration and stop polling', async () => {
  const { coordinator, displays, timers } = harness()
  await coordinator.dispatch('node-a')

  coordinator.noteLedgerEvent({
    seq: 9,
    project_id: 'project-a',
    ts: '2026-08-31T12:00:00.000Z',
    actor: 'worker:w1',
    type: 'WORKER_LOG',
    payload: { node_id: 'node-a', lines: ['starting'] },
    idem_key: 'event-9',
  })

  assert.equal(timers.size, 0)
  assert.equal(displays.at(-1), null)
})

test('unmount cancels polling and a new browser session probes again', async () => {
  const { calls, coordinator, timers } = harness()
  await coordinator.dispatch('node-a')
  coordinator.setMounted(false)
  assert.equal(timers.size, 0)

  coordinator.setMounted(true)
  coordinator.activate({ project: 'project-a', token: 'token-a', sessionId: 'session-b' })
  await coordinator.dispatch('node-b')

  assert.deepEqual(
    calls.filter(([name]) => name === 'status'),
    [
      ['status', 'project-a', 'session-a'],
      ['status', 'project-a', 'session-b'],
    ],
  )
})

test('fleet status copy is pinned for queued, starting, and honest degradation', () => {
  assert.equal(
    liveFleetDisplayText({ nodeId: 'node-a', phase: 'queued', position: 7 }),
    'Live fleet: queued (#7)',
  )
  assert.equal(
    liveFleetDisplayText({ nodeId: 'node-a', phase: 'starting' }),
    'Live fleet: worker starting',
  )
  assert.equal(
    liveFleetDisplayText({ nodeId: 'node-a', phase: 'degraded' }),
    'The shared live fleet is busy right now — live execution is demonstrated in the video.',
  )
})
