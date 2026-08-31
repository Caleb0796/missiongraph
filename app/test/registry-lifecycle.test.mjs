import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RegistryLifecycle,
  missionClientReadiness,
} from '../src/webmcp/registry-lifecycle.ts'

const CORE_TOOLS = [
  'hello_missiongraph',
  'plan_seed',
  'add_task',
  'split_task',
  'link',
  'unlink',
  'annotate',
  'remove',
  'graph_digest',
  'list_ready',
  'list_pending_approvals',
  'state_policy',
  'approve',
  'reject',
  'dispatch',
  'retry_with_guidance',
  'set_node_run_state',
  'get_node',
  'get_critical_path',
  'get_selection',
  'focus',
  'highlight_path',
  'explain_overlay',
  'journal_note',
  'get_journal',
]

async function flushMicrotasks() {
  for (let index = 0; index < CORE_TOOLS.length + 10; index++) {
    await Promise.resolve()
  }
}

async function advanceTime(t, milliseconds) {
  let remaining = milliseconds
  while (remaining > 0) {
    const step = Math.min(50, remaining)
    t.mock.timers.tick(step)
    await flushMicrotasks()
    remaining -= step
  }
}

function harness(runtimeAtStart = false) {
  let runtime = runtimeAtStart ? {} : null
  let failAtRegistration = null
  let registrations = 0
  let bootstrapCalls = 0
  let duplicates = 0
  const active = new Set()
  const statusChanges = []
  const lifecycle = new RegistryLifecycle({
    getRuntime: () => runtime,
    async bootstrap(_runtime, scope) {
      bootstrapCalls++
      for (const name of CORE_TOOLS) {
        const controller = new AbortController()
        scope.addCleanup(() => controller.abort())
        controller.signal.addEventListener(
          'abort',
          () => active.delete(name),
          { once: true },
        )
        registrations++
        if (registrations === failAtRegistration) {
          throw new Error('registration interrupted')
        }
        if (active.has(name)) duplicates++
        active.add(name)
        await Promise.resolve()
      }
      return {
        namespace: 'document',
        dynamicToolsTier: 'abort-controller',
      }
    },
  })
  lifecycle.subscribe(() => statusChanges.push(lifecycle.getStatus().state))
  return {
    lifecycle,
    active,
    statusChanges,
    injectRuntime() {
      runtime = {}
    },
    failAt(nextRegistration) {
      failAtRegistration = nextRegistration
    },
    clearFailure() {
      failAtRegistration = null
    },
    registrations: () => registrations,
    bootstrapCalls: () => bootstrapCalls,
    duplicates: () => duplicates,
  }
}

test('runtime injected 1.2s after initialization registers every core tool once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = harness()
  assert.deepEqual(await registry.lifecycle.initialize(), { state: 'waiting' })

  await advanceTime(t, 1_200)
  registry.injectRuntime()
  await advanceTime(t, 50)

  assert.deepEqual([...registry.active], CORE_TOOLS)
  assert.equal(registry.duplicates(), 0)
  assert.equal(registry.bootstrapCalls(), 1)
  assert.deepEqual(registry.statusChanges, ['active'])
  await registry.lifecycle.dispose()
})

test('runtime injected after the fast window still registers through the slow poller', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = harness()
  await registry.lifecycle.initialize()

  await advanceTime(t, 8_000)
  registry.injectRuntime()
  await advanceTime(t, 1_000)

  assert.equal(registry.lifecycle.getStatus().state, 'active')
  assert.deepEqual([...registry.active], CORE_TOOLS)
  assert.equal(registry.bootstrapCalls(), 1)
  await registry.lifecycle.dispose()
})

test('concurrent initialization calls share one registration promise', async () => {
  const registry = harness(true)
  const first = registry.lifecycle.initialize()
  const second = registry.lifecycle.initialize()

  assert.strictEqual(first, second)
  await Promise.all([first, second])
  assert.equal(registry.bootstrapCalls(), 1)
  assert.equal(registry.registrations(), CORE_TOOLS.length)
  await registry.lifecycle.dispose()
})

test('manual re-check performs a fresh waiting-state attempt', async () => {
  const registry = harness()
  const first = registry.lifecycle.initialize()
  await first

  const recheck = registry.lifecycle.recheck()
  assert.notStrictEqual(recheck, first)
  assert.deepEqual(await recheck, { state: 'waiting' })

  registry.injectRuntime()
  await registry.lifecycle.recheck()
  assert.equal(registry.lifecycle.getStatus().state, 'active')
  await registry.lifecycle.dispose()
})

test('failed partial registration is cleaned up and a fresh retry succeeds', async () => {
  const registry = harness(true)
  registry.failAt(3)
  const failed = registry.lifecycle.initialize()
  await assert.rejects(failed, /registration interrupted/)
  assert.deepEqual([...registry.active], [])

  registry.clearFailure()
  const retried = registry.lifecycle.initialize()
  assert.notStrictEqual(retried, failed)
  await retried
  assert.deepEqual([...registry.active], CORE_TOOLS)
  assert.equal(registry.duplicates(), 0)
  await registry.lifecycle.dispose()
})

test('dispose followed by initialize performs a clean re-registration', async () => {
  const registry = harness(true)
  await registry.lifecycle.initialize()
  assert.equal(registry.active.size, CORE_TOOLS.length)

  await registry.lifecycle.dispose()
  assert.equal(registry.active.size, 0)
  assert.equal(registry.lifecycle.getStatus().state, 'waiting')

  await registry.lifecycle.initialize()
  assert.deepEqual([...registry.active], CORE_TOOLS)
  assert.equal(registry.bootstrapCalls(), 2)
  assert.equal(registry.duplicates(), 0)
  await registry.lifecycle.dispose()
})

test('StrictMode-style double initialization produces one registration', async () => {
  const registry = harness(true)
  const setup = () => registry.lifecycle.initialize()
  await Promise.all([setup(), setup()])
  await setup()

  assert.equal(registry.bootstrapCalls(), 1)
  assert.equal(registry.registrations(), CORE_TOOLS.length)
  assert.equal(registry.duplicates(), 0)
  await registry.lifecycle.dispose()
})

test('runtime present at t0 retains immediate Chrome-path registration', async () => {
  const registry = harness(true)
  const status = await registry.lifecycle.initialize()

  assert.deepEqual(status, {
    state: 'active',
    namespace: 'document',
    dynamicToolsTier: 'abort-controller',
  })
  assert.deepEqual([...registry.active], CORE_TOOLS)
  await registry.lifecycle.dispose()
})

test('tool discovery is independent of a blocked mission-client initialization', async () => {
  const registry = harness(true)
  const blockedMissionClient = new Promise(() => undefined)

  await registry.lifecycle.initialize()

  assert.deepEqual([...registry.active], CORE_TOOLS)
  assert.deepEqual(await missionClientReadiness(blockedMissionClient), {
    state: 'pending',
  })
  await registry.lifecycle.dispose()
})

test('mission-client readiness distinguishes ready and failed execution gates', async () => {
  assert.deepEqual(await missionClientReadiness(Promise.resolve()), {
    state: 'ready',
  })
  const failure = new Error('server handshake failed')
  assert.deepEqual(await missionClientReadiness(Promise.reject(failure)), {
    state: 'failed',
    error: failure,
  })
})
