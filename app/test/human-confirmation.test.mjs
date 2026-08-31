import assert from 'node:assert/strict'
import test from 'node:test'

import {
  confirmationMatches,
  requireConfirmationSlot,
} from '../src/store/human-confirmation.ts'

test('a displayed confirmation rejects substitution and remains exactly bound', async () => {
  let confirmedA = 0
  let confirmedB = 0
  const draftA = {
    id: 'draft-a',
    textHash: 'hash-a',
    confirm: async () => {
      confirmedA++
    },
  }
  const draftB = {
    id: 'draft-b',
    textHash: 'hash-b',
    confirm: async () => {
      confirmedB++
    },
  }
  let displayed = draftA

  assert.throws(
    () => requireConfirmationSlot(displayed),
    (error) => error.code === 'confirmation_busy',
  )
  assert.strictEqual(displayed, draftA)
  assert.equal(
    confirmationMatches(displayed, draftB.id, draftB.textHash),
    false,
  )
  if (confirmationMatches(displayed, draftA.id, draftA.textHash)) {
    await displayed.confirm()
  }

  assert.equal(confirmedA, 1)
  assert.equal(confirmedB, 0)
})
