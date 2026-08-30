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
  assert.ok(connectProject.indexOf("await loadChangesSince('0')") < connectProject.indexOf('openRealtime()'))
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

test('all M4 tools emit their contract events and require policy attribution', async () => {
  const tools = await source('../src/webmcp/tools.ts')
  const statePolicy = tools.slice(
    tools.indexOf("name: 'state_policy'"),
    tools.indexOf("const approve"),
  )
  const dispatch = tools.slice(
    tools.indexOf("name: 'dispatch'"),
    tools.indexOf("const retryWithGuidance"),
  )
  const retry = tools.slice(
    tools.indexOf("name: 'retry_with_guidance'"),
    tools.indexOf("const getNode"),
  )
  assert.match(statePolicy, /'POLICY_STATED'/)
  assert.match(statePolicy, /session_id: sessionId/)
  assert.match(dispatch, /brief_override/)
  assert.match(dispatch, /bypass_cap: bypassCap/)
  assert.match(dispatch, /'DISPATCHED'/)
  assert.match(retry, /string\(inputs\.guidance, 'guidance'\)/)
  assert.match(retry, /'RETRY_REQUESTED'/)
  assert.match(tools, /required: \['id', 'policy_ref'\]/)
  assert.match(tools, /statePolicy,[\s\S]*dispatch,[\s\S]*retryWithGuidance/)
})

test('expired identities re-clone visibly and realtime resumes from the folded cursor', async () => {
  const client = await source('../src/transport/client.ts')
  assert.match(client, /shouldReplaceStoredIdentity\(error\.code\)/)
  assert.match(
    client,
    /previous session expired — started a fresh mission copy/,
  )
  assert.match(client, /setConnectionMode\('loading', 'Starting a fresh mission copy…'\)/)
  assert.match(client, /realtimeEndpoint\('websocket', client, cursor\)/)
  assert.match(client, /realtimeEndpoint\('sse', client, cursor\)/)
  assert.match(client, /sequenceDisposition\(store\.cursor, data\.event\.seq\)/)
  assert.match(client, /scheduleReconnect\(true\)/)
})

test('tool console keeps unknown tools and malformed JSON as inline errors', async () => {
  const consolePage = await source('../src/pages/ToolsPage.tsx')
  assert.match(consolePage, /This tool is unknown or was removed/)
  assert.match(consolePage, /Input is not valid JSON/)
  assert.match(consolePage, /tool-console-error/)
  assert.doesNotMatch(consolePage, /find\(\(tool\) => tool\.name === selected\)!/)
})

test('capability links and fixture labeling stay explicit', async () => {
  const client = await source('../src/transport/client.ts')
  const pulse = await source('../src/components/PulseBar.tsx')
  assert.match(client, /searchParams\.set\('mg_project', identity\.project\)/)
  assert.match(client, /searchParams\.set\('mg_token', identity\.token\)/)
  assert.match(pulse, /connectionMode === 'fixture'/)
  assert.match(pulse, /Dev fixture projection/)
  assert.doesNotMatch(pulse, /connectionMessage\.includes\('fixture projection'\)/)
})
