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
  await controller.update([tool('split_selected'), tool('split_selected')])
  assert.deepEqual([...context.active], ['split_selected'])
  const unchangedEvents = context.toolchange.length
  await controller.update([tool('split_selected')])
  assert.equal(context.toolchange.length, unchangedEvents)
  await controller.update([tool('annotate_selected')])
  assert.deepEqual([...context.active], ['annotate_selected'])
  await controller.update([])
  assert.deepEqual([...context.active], [])
  assert.ok(context.toolchange.length >= 4)
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

test('fallback tier leaves its always-registered contextual surface untouched', async () => {
  const context = modelContext()
  const controller = new DynamicToolController(context, 'none', [tool('core')])
  await controller.update([tool('split_selected')])
  await controller.update([])
  assert.equal(context.toolchange.length, 0)
  assert.equal(context.provided.length, 0)
  assert.deepEqual([...context.active], [])
})
