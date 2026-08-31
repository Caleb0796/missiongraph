import assert from 'node:assert/strict'
import test from 'node:test'

import { DynamicToolController } from '../src/webmcp/dynamic-tools.ts'

const tool = (name) => ({ name })

function modelContext() {
  const active = new Set()
  const toolchange = []
  const provided = []
  return {
    active,
    toolchange,
    provided,
    registerTool(item, options) {
      active.add(item.name)
      toolchange.push([...active].sort())
      options?.signal?.addEventListener(
        'abort',
        () => {
          active.delete(item.name)
          toolchange.push([...active].sort())
        },
        { once: true },
      )
    },
    provideContext(context) {
      provided.push(context.tools.map((item) => item.name))
      active.clear()
      context.tools.forEach((item) => active.add(item.name))
      toolchange.push([...active].sort())
    },
  }
}

test('abort-controller tier unregisters contextual tools without leaks or duplicates', async () => {
  const context = modelContext()
  const controller = new DynamicToolController(
    context,
    'abort-controller',
    [tool('core')],
  )
  await controller.update([
    tool('split_selected'),
    tool('annotate_selected'),
    tool('split_selected'),
  ])
  assert.deepEqual([...context.active].sort(), [
    'annotate_selected',
    'split_selected',
  ])
  const unchangedEvents = context.toolchange.length
  await controller.update([tool('split_selected'), tool('annotate_selected')])
  assert.equal(context.toolchange.length, unchangedEvents)
  await controller.update([tool('annotate_selected'), tool('explain_selected')])
  assert.deepEqual([...context.active].sort(), [
    'annotate_selected',
    'explain_selected',
  ])
  assert.equal(context.toolchange.length, 4)
  await controller.update([])
  assert.deepEqual([...context.active], [])
  assert.equal(context.toolchange.length, 6)
})

test('registration failures stop after three attempts until a selection retry', async () => {
  let attempts = 0
  const statuses = []
  const target = {
    registerTool() {
      attempts++
      throw new Error('browser rejected registration')
    },
  }
  const controller = new DynamicToolController(
    target,
    'abort-controller',
    [tool('core')],
    {
      delay: async () => undefined,
      onStatus: (status) => statuses.push(status.degraded),
    },
  )
  await controller.update([tool('split_selected')])
  assert.equal(attempts, 3)
  assert.equal(statuses.at(-1), true)

  await controller.update([tool('annotate_selected')])
  assert.equal(attempts, 3)

  await controller.update([tool('annotate_selected')], true)
  assert.equal(attempts, 6)
  assert.deepEqual(statuses.slice(-2), [false, true])
})

test('provide-context tier replaces the full set and converges after rapid selection changes', async () => {
  const context = modelContext()
  const controller = new DynamicToolController(
    context,
    'provide-context',
    [tool('core'), tool('digest')],
  )
  const first = controller.update([tool('dispatch_selected')])
  const second = controller.update([tool('split_selected'), tool('split_selected')])
  const third = controller.update([tool('annotate_selected')])
  await Promise.all([first, second, third])
  assert.deepEqual(context.provided.at(-1), [
    'core',
    'digest',
    'annotate_selected',
  ])
  assert.deepEqual([...context.active].sort(), [
    'annotate_selected',
    'core',
    'digest',
  ])
  assert.ok(context.toolchange.length >= 1)
})

test('provide-context failures share the bounded retry budget', async () => {
  let attempts = 0
  const controller = new DynamicToolController(
    {
      registerTool() {},
      provideContext() {
        attempts++
        throw new Error('context rejected')
      },
    },
    'provide-context',
    [tool('core')],
    { delay: async () => undefined },
  )
  await controller.update([tool('split_selected')])
  assert.equal(attempts, 3)
  await controller.update([tool('annotate_selected')])
  assert.equal(attempts, 3)
})

test('fallback tier leaves its always-registered contextual surface untouched', async () => {
  const context = modelContext()
  const controller = new DynamicToolController(context, 'none', [tool('core')])
  await controller.update([tool('split_selected')])
  await controller.update([])
  assert.equal(context.toolchange.length, 0)
  assert.equal(context.provided.length, 0)
  assert.deepEqual([...context.active], [])
})
