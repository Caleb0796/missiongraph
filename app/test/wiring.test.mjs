import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (relative) =>
  readFile(new URL(relative, import.meta.url), 'utf8')

test('live hydration replays seed history before tailing', async () => {
  const client = await source('../src/transport/client.ts')
  const connectProject = client.slice(
    client.indexOf('async function connectProject'),
    client.indexOf('export function initializeMissionClient'),
  )
  assert.ok(connectProject.indexOf("await loadChangesSince('0')") >= 0)
  assert.ok(connectProject.indexOf("await loadChangesSince('0')") < connectProject.indexOf('openSocket()'))
})

test('stale mutations surface without reposting', async () => {
  const client = await source('../src/transport/client.ts')
  const postMutation = client.slice(
    client.indexOf('async function postMutation<T'),
    client.indexOf('async function postMutationBatch'),
  )
  assert.match(postMutation, /'stale_mutation'/)
  assert.doesNotMatch(postMutation, /return postMutation\(/)
})

test('plan_seed uses one batch and native edits stage a visible confirmation', async () => {
  const tools = await source('../src/webmcp/tools.ts')
  const planSeed = tools.slice(
    tools.indexOf("name: 'plan_seed'"),
    tools.indexOf("const addTask"),
  )
  const store = await source('../src/store/mission-store.ts')
  const inspector = await source('../src/components/Inspector.tsx')
  assert.match(planSeed, /await mutateBatch\(batch/)
  assert.doesNotMatch(planSeed, /await mutate\(/)
  assert.match(store, /structuralPreview:/)
  assert.match(store, /isPreviewStale\(pending\.baseCursor, state\.cursor\)/)
  assert.match(inspector, /annotations\[node\.id\]/)
})
