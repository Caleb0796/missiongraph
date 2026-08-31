import assert from 'node:assert/strict'
import test from 'node:test'

import { SettledDebouncer } from '../src/transport/settled-debounce.ts'

test('rapid cosmetic selection posts debounce to the settled local value', async () => {
  let nextTimer = 0
  const timers = new Map()
  const scheduler = {
    setTimeout(callback) {
      const id = ++nextTimer
      timers.set(id, callback)
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
  }
  const posted = []
  let cursor = 8
  const debouncer = new SettledDebouncer(scheduler)
  const first = debouncer.schedule('selection', 300, 8, async () => {
    posted.push({ id: 'task-a', cursor })
    return 9
  })
  cursor = 9
  const second = debouncer.schedule('selection', 300, 8, async () => {
    posted.push({ id: 'task-b', cursor })
    return cursor
  })
  assert.equal(await first, 8)
  assert.equal(timers.size, 1)
  cursor = 10
  timers.values().next().value()
  assert.equal(await second, 10)
  assert.deepEqual(posted, [{ id: 'task-b', cursor: 10 }])
})
