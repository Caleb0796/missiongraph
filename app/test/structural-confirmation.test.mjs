import assert from 'node:assert/strict'
import test from 'node:test'

import { StructuralConfirmationController } from '../src/store/structural-confirmation.ts'

test('stale confirmation rotates the token and rebinds one frozen operation', async () => {
  let token = 0
  let prepareCount = 0
  const applied = []
  const payload = { parent_id: 'payments', child_ids: ['intent', 'capture'] }
  const controller = new StructuralConfirmationController(
    () => `token-${++token}`,
  )
  const operation = controller.stage({
    key: 'split:payments',
    title: 'Split Payments',
    ids: ['payments'],
    cursor: '8',
    projectId: 'project-a',
    prepare: () => {
      const boundCursor = ++prepareCount
      return async () => {
        applied.push({ boundCursor, payload })
        return boundCursor
      }
    },
  })
  assert.equal(operation.opToken, 'token-1')
  assert.equal(prepareCount, 1)

  const stale = await controller.confirm(
    operation.key,
    operation.opToken,
    '9',
    'project-a',
  )
  assert.equal(stale.applied, false)
  assert.equal(stale.operation.opToken, 'token-2')
  assert.equal(stale.operation.baseCursor, '9')
  assert.equal(prepareCount, 2)
  assert.deepEqual(applied, [])

  const confirmed = await controller.confirm(
    operation.key,
    stale.operation.opToken,
    '9',
    'project-a',
  )
  assert.deepEqual(confirmed, { applied: true, value: 2 })
  assert.deepEqual(applied, [{ boundCursor: 2, payload }])
})

test('confirmation cannot cross project identity', async () => {
  const controller = new StructuralConfirmationController(() => 'token')
  const operation = controller.stage({
    key: 'split:payments',
    title: 'Split Payments',
    ids: ['payments'],
    cursor: '8',
    projectId: 'project-a',
    prepare: () => async () => undefined,
  })
  await assert.rejects(
    controller.confirm(operation.key, operation.opToken, '8', 'project-b'),
    /project changed/,
  )
  await assert.rejects(
    controller.confirm(operation.key, operation.opToken, '8', 'project-a'),
    /missing, expired/,
  )
})
