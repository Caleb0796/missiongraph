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
  assert.ok(connectProject.indexOf("await loadChangesSince('0', candidate)") >= 0)
  assert.ok(
    connectProject.indexOf("await loadChangesSince('0', candidate)") <
      connectProject.indexOf('openRealtime(candidate)'),
  )
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

test('identity recovery is source-aware and realtime resumes with fenced backoff', async () => {
  const client = await source('../src/transport/client.ts')
  const linkedBranch = client.slice(
    client.indexOf('const linked = sharedIdentityFromUrl()'),
    client.indexOf('const persisted = storedIdentity()'),
  )
  const storedBranch = client.slice(
    client.indexOf('const persisted = storedIdentity()'),
    client.indexOf(
      'const cloned = await cloneDemo()',
      client.indexOf('const persisted = storedIdentity()'),
    ),
  )
  assert.match(client, /identityFailureDisposition\('url', error\.status\)/)
  assert.match(client, /showInvalidMissionLink\(storedIdentity\(\) !== null\)/)
  assert.match(client, /identityFailureDisposition\('stored', error\.status\)/)
  assert.doesNotMatch(linkedBranch, /localStorage\.removeItem\(IDENTITY_KEY\)/)
  assert.match(storedBranch, /localStorage\.removeItem\(IDENTITY_KEY\)/)
  assert.match(
    client,
    /previous session expired — started a fresh mission copy/,
  )
  assert.match(client, /setConnectionMode\('loading', 'Starting a fresh mission copy…'\)/)
  assert.match(client, /realtimeEndpoint\('websocket', candidate\.client, cursor\)/)
  assert.match(client, /realtimeEndpoint\('sse', candidate\.client, cursor\)/)
  assert.match(client, /sequenceDisposition\(store\.cursor, data\.event\.seq\)/)
  assert.doesNotMatch(client, /scheduleReconnect\(true\)/)
  assert.match(client, /failedWebSockets\+\+/)
  assert.match(client, /connectionProvedStable/)
  const reconnect = client.slice(
    client.indexOf('function scheduleReconnect()'),
    client.indexOf('function proveConnectionStable'),
  )
  assert.match(reconnect, /setConnectionMode\(\s*'loading'/)
})

test('all stream readers and store folds are fenced to project identity', async () => {
  const client = await source('../src/transport/client.ts')
  const store = await source('../src/store/mission-store.ts')
  assert.match(client, /identityEpoch/)
  assert.match(client, /historyClosers/)
  assert.match(client, /for \(const close of \[\.\.\.historyClosers\]\) close\(\)/)
  assert.match(client, /data\.event\.project_id !== candidate\.client\.project/)
  assert.match(store, /eventBelongsToProject\(state\.projectId, event\.project_id\)/)
  assert.match(store, /shouldApplySnapshot\(/)
})

test('server digest is the shared approval-order source', async () => {
  const client = await source('../src/transport/client.ts')
  const store = await source('../src/store/mission-store.ts')
  const panel = await source('../src/components/FlightPanel.tsx')
  const tools = await source('../src/webmcp/tools.ts')
  assert.match(client, /base_seq: cursor - 1/)
  assert.match(client, /applyServerDigest\(candidate\.client\.project, stale\.fresh_digest\)/)
  assert.match(store, /approvalRankingSource: 'server'/)
  assert.match(panel, /approvalQueueFromRanking\(approvals, approvalRanking\)/)
  assert.match(tools, /approvalQueueFromRanking\(/)
  assert.doesNotMatch(panel, /fixtureRankedPendingApprovals/)
})

test('WebMCP cursor and bootstrap retries are project-scoped', async () => {
  const registry = await source('../src/webmcp/registry.ts')
  const client = await source('../src/transport/client.ts')
  const pulse = await source('../src/components/PulseBar.tsx')
  assert.match(registry, /clientCursor\?\.projectId === storeBefore\.projectId/)
  assert.match(registry, /projectId: storeAfter\.projectId/)
  assert.match(client, /bootstrapRetryDelay\(bootstrapAttempt\+\+\)/)
  assert.match(client, /initialization = null/)
  assert.match(client, /export function reconnectMission\(\)/)
  assert.match(pulse, />\s*Reconnect\s*</)
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
  assert.match(client, /searchParams\.set\('mg_project', candidate\.client\.project\)/)
  assert.match(client, /searchParams\.set\('mg_token', candidate\.client\.token\)/)
  assert.match(client, /document\.execCommand\('copy'\)/)
  assert.match(pulse, /disabled=\{connectionMode !== 'live'\}/)
  assert.match(pulse, /Start a fresh mission copy/)
  assert.match(pulse, /Open my stored mission/)
  assert.match(pulse, /connectionMode === 'fixture'/)
  assert.match(pulse, /Dev fixture projection/)
  assert.doesNotMatch(pulse, /connectionMessage\.includes\('fixture projection'\)/)
})
