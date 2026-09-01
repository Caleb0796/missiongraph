import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONTENT_POLICY,
  contentSafeAnnotations,
  contentSafeEnvelope,
} from '../src/webmcp/content-policy.ts'

test('shared envelopes label and bound untrusted prose, and every tool carries the hint', () => {
  const longText = 'x'.repeat(2_050)
  const safe = contentSafeEnvelope(
    {
      data: {
        entries: [{ text: longText }],
        worker_log_tail: [longText],
      },
    },
    Array.from({ length: 60 }, (_, index) => ({
      seq: index + 1,
      actor: 'worker:test',
      type: 'WORKER_LOG',
      one_liner: longText,
    })),
  )

  assert.equal(safe.contentPolicy, CONTENT_POLICY)
  assert.equal(safe.changes.length, 50)
  assert.equal(safe.changes[0].seq, 11)
  assert.equal(safe.changes[0].truncated, true)
  assert.equal(safe.changes[0].one_liner.length, 2_000)
  assert.match(safe.changes[0].one_liner, /…\[truncated\]$/)
  assert.equal(safe.outcome.data.entries[0].truncated, true)
  assert.equal(safe.outcome.data.entries[0].text.length, 2_000)
  assert.equal(safe.outcome.data.truncated, true)
  assert.equal(safe.outcome.data.worker_log_tail[0].length, 2_000)
  assert.deepEqual(contentSafeAnnotations({ readOnlyHint: true }), {
    readOnlyHint: true,
    untrustedContentHint: true,
  })
  assert.deepEqual(contentSafeAnnotations(), { untrustedContentHint: true })
})
