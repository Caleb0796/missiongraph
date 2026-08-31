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

test('stale-epoch 409 responses are discarded before digest application', async () => {
  const client = await source('../src/transport/client.ts')
  const postMutation = client.slice(
    client.indexOf('async function postMutation<T'),
    client.indexOf('async function postMutationBatch'),
  )
  const responseBodyHelper = client.slice(
    client.indexOf('async function mutationResponseBody<T>'),
    client.indexOf('async function mutationJsonResponse<T>'),
  )
  const guardedBody = postMutation.indexOf(
    'const stale = await mutationResponseBody<StaleBody>',
  )
  const digestApplication = postMutation.indexOf('.applyDigestChanges(')
  assert.match(postMutation, /'stale_mutation'/)
  assert.doesNotMatch(postMutation, /return postMutation\(/)
  assert.match(
    responseBodyHelper,
    /finally \{\s*assertMutationContextActive\(context, operation\)/,
  )
  assert.ok(guardedBody >= 0)
  assert.ok(digestApplication > guardedBody)
  assert.match(postMutation, /'mutation 409 response'/)
  assert.match(
    postMutation,
    /\.applyDigestChanges\(\s*candidate\.client\.project,/,
  )
})

test('queued, debounced, batch, and preview mutations retain initiation context', async () => {
  const client = await source('../src/transport/client.ts')
  const tools = await source('../src/webmcp/tools.ts')
  const store = await source('../src/store/mission-store.ts')
  const mutateBlock = client.slice(
    client.indexOf('export function mutate<T'),
    client.indexOf('function sharedIdentityFromUrl'),
  )
  const batchBlock = client.slice(
    client.indexOf('async function postMutationBatch'),
    client.indexOf('function sharedIdentityFromUrl'),
  )
  assert.match(mutateBlock, /const context = captureMutationContext\(\)/)
  assert.match(
    mutateBlock,
    /enqueueMutation\(type, payload, actor, context\)/,
  )
  assert.doesNotMatch(
    mutateBlock,
    /setTimeout\([\s\S]*?mutate\(type, payload/,
  )
  assert.match(batchBlock, /postMutationBatch\(batch, actor, context\)/)
  assert.match(tools, /const applyMutation = prepareMutation\(/)
  assert.match(store, /const prepare = \(\) => prepareStoreMutation\(/)
})

test('plan_seed uses one batch and native edits stage a visible confirmation', async () => {
  const tools = await source('../src/webmcp/tools.ts')
  const planSeed = tools.slice(
    tools.indexOf("name: 'plan_seed'"),
    tools.indexOf("const addTask"),
  )
  const store = await source('../src/store/mission-store.ts')
  const confirmation = await source('../src/store/structural-confirmation.ts')
  const inspector = await source('../src/components/Inspector.tsx')
  assert.match(planSeed, /await mutateBatch\(batch/)
  assert.doesNotMatch(planSeed, /await mutate\(/)
  assert.match(store, /structuralPreview:/)
  assert.match(confirmation, /pending\.baseCursor !== cursor/)
  assert.match(confirmation, /pending\.apply = apply/)
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
  assert.match(store, /applyDigestChanges\(projectId, changes, cursor\)/)
  assert.match(
    store,
    /shouldApplyDigest\(\s*state\.projectId,\s*state\.cursor,\s*projectId,\s*cursor/,
  )
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
  assert.match(panel, /ranking may be stale/)
  assert.match(tools, /approvalQueueFromRanking\(/)
  assert.doesNotMatch(panel, /fixtureRankedPendingApprovals/)
  assert.match(client, /digestRetryDelay\(digestRetryAttempt\+\+\)/)
  assert.match(client, /markApprovalRankingStale\(candidate\.client\.project\)/)
})

test('WebMCP cursor and bootstrap retries are project-scoped', async () => {
  const registry = await source('../src/webmcp/registry.ts')
  const client = await source('../src/transport/client.ts')
  const pulse = await source('../src/components/PulseBar.tsx')
  assert.match(registry, /toolCursorForProject\(/)
  assert.match(registry, /projectId: storeAfter\.projectId/)
  assert.match(registry, /cursor: projectChanged \? '0' : storeAfter\.cursor/)
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
  const copyText = client.slice(
    client.indexOf('async function copyText'),
    client.indexOf('export async function copyCurrentMissionLink'),
  )
  assert.match(copyText, /catch \{\s*return false/)
  assert.match(pulse, /disabled=\{connectionMode !== 'live'\}/)
  assert.match(pulse, /Start a fresh mission copy/)
  assert.match(pulse, /Open my stored mission/)
  assert.match(pulse, /connectionMode === 'fixture'/)
  assert.match(pulse, /Dev fixture projection/)
  assert.doesNotMatch(pulse, /connectionMessage\.includes\('fixture projection'\)/)
})

test('automatic identity recovery clears inherited transport penalties', async () => {
  const client = await source('../src/transport/client.ts')
  const recovery = client.slice(
    client.indexOf('async function recoverExpiredIdentity'),
    client.indexOf('async function reconnect()'),
  )
  assert.match(recovery, /deactivateIdentity\(candidate\)/)
  assert.match(recovery, /resetTransportPenalties\(\)/)
  assert.ok(
    recovery.indexOf('resetTransportPenalties()') >
      recovery.indexOf('deactivateIdentity(candidate)'),
  )
})

test('M5 split shares cursor-bound UI confirmation and a frozen atomic batch', async () => {
  const tools = await source('../src/webmcp/tools.ts')
  const store = await source('../src/store/mission-store.ts')
  const client = await source('../src/transport/client.ts')
  const split = await source('../src/webmcp/split.ts')
  const confirmation = await source('../src/store/structural-confirmation.ts')
  assert.match(tools, /name: 'split_task'/)
  assert.match(tools, /prepareBatchMutation\(batch/)
  assert.match(tools, /stageStructural\(key, title, ids, prepare\)/)
  assert.match(tools, /error:\s*\{\s*code: 'preview_stale'/)
  assert.match(store, /confirmStructuralToken\(key, opToken\)/)
  assert.match(store, /structuralConfirmation\.confirm\(/)
  assert.match(store, /blastRadius: getBlastRadius/)
  assert.match(confirmation, /pending\.opToken = this\.makeToken\(\)/)
  assert.match(confirmation, /pending\.apply = apply/)
  assert.match(client, /export function prepareBatchMutation\(/)
  assert.match(split, /type: 'TASK_SPLIT'/)
  assert.match(split, /type: 'EDGE_REMOVED'/)
  assert.match(split, /type: 'EDGE_ADDED'/)
})

test('M5 contextual registry updates all three tiers idempotently', async () => {
  const registry = await source('../src/webmcp/registry.ts')
  const dynamic = await source('../src/webmcp/dynamic-tools.ts')
  const tools = await source('../src/webmcp/tools.ts')
  assert.match(registry, /new DynamicToolController\(/)
  assert.match(registry, /useMissionStore\.subscribe/)
  assert.match(registry, /void refreshContextualTools\(\)/)
  assert.match(dynamic, /this\.dynamicController\?\.abort\(\)/)
  assert.match(dynamic, /this\.target\.provideContext/)
  assert.match(dynamic, /if \(this\.tier === 'none'\) return/)
  assert.match(dynamic, /new Map\(tools\.map/)
  assert.match(tools, /label: 'not_applicable'/)
  assert.match(tools, /dispatchSelected,[\s\S]*explainSelected,[\s\S]*annotateSelected,[\s\S]*splitSelected,[\s\S]*reviewFailures/)
})

test('M5 visual wiring exposes blast radius, relayout, split ancestry, and pause state', async () => {
  const canvas = await source('../src/components/GraphCanvas.tsx')
  const card = await source('../src/components/TaskNodeCard.tsx')
  const inspector = await source('../src/components/Inspector.tsx')
  const store = await source('../src/store/mission-store.ts')
  assert.match(canvas, /mission-flow-node--relayouting/)
  assert.match(canvas, /structuralPreview\?\.blastRadius\.stale/)
  assert.match(card, /mission-node--preview-pausing/)
  assert.match(card, /mission-node--split-parent/)
  assert.match(inspector, /Open parent history/)
  assert.match(inspector, /previewNativeSplit/)
  assert.match(store, /case 'TASK_SPLIT'/)
  assert.match(store, /pause_requested: true/)
})
