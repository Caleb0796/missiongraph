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

test('queued and preview mutations retain context while debounce captures it at timer fire', async () => {
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
  assert.match(
    mutateBlock,
    /\(\) => \{\s*const context = captureMutationContext\(options\.staleMode\)\s*return executeSingleWithPresence/,
  )
  assert.match(
    mutateBlock,
    /executeSingleWithPresence\(type, payload, actor, context\)/,
  )
  assert.doesNotMatch(
    mutateBlock,
    /setTimeout\([\s\S]*?mutate\(type, payload/,
  )
  assert.match(batchBlock, /postMutationBatch\(batch, actor, context\)/)
  assert.match(tools, /const applyMutation = prepareMutation\(/)
  assert.match(
    store,
    /const prepare = \(\) => prepareStoreMutation\('EDGE_ADDED', payload, \{\s*staleMode: 'silent',\s*\}\)/,
  )
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
  assert.match(confirmation, /pending\.baseCursor !== context\.cursor/)
  assert.match(confirmation, /const plan = pending\.recompute\(\)/)
  assert.match(confirmation, /pending\.apply = plan\.apply/)
  assert.match(inspector, /annotations\[node\.id\]/)
})

test('live plan_seed keeps temp_id local while wiring persistent task ids', async () => {
  const tools = await source('../src/webmcp/tools.ts')
  const planSeed = tools.slice(
    tools.indexOf("name: 'plan_seed'"),
    tools.indexOf('const addTask'),
  )
  const batchIdMap = planSeed.slice(
    planSeed.indexOf('const batchIds'),
    planSeed.indexOf('const candidateEdges'),
  )

  assert.match(
    batchIdMap,
    /const batchIds = new Map\(\s*tasks\.map\(\(task\) => \[task\.temp_id, crypto\.randomUUID\(\)\]\),\s*\)/,
  )
  assert.doesNotMatch(batchIdMap, /connectionMode/)
  assert.match(planSeed, /const upstream = batchIds\.get\(dep\) \?\? dep/)
  assert.match(planSeed, /const downstream = batchIds\.get\(task\.temp_id\)!/)
  assert.match(planSeed, /id: batchIds\.get\(task\.temp_id\)!/)
  assert.match(planSeed, /node_id: batchIds\.get\(task\.temp_id\)!/)
})

test('all M4 tools stage policy confirmation and require policy attribution', async () => {
  const tools = await source('../src/webmcp/tools.ts')
  const client = await source('../src/transport/client.ts')
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
  const policyStaging = client.slice(
    client.indexOf('export async function stagePolicyDraft'),
    client.indexOf('function sharedIdentityFromUrl'),
  )
  assert.match(statePolicy, /await stagePolicyDraft\(text\)/)
  assert.match(statePolicy, /status: 'pending_human_confirmation'/)
  assert.doesNotMatch(statePolicy, /'POLICY_STATED'/)
  assert.doesNotMatch(statePolicy, /policy_ref:/)
  assert.doesNotMatch(statePolicy, /capability:/)
  assert.match(policyStaging, /kind: 'policy'/)
  assert.match(policyStaging, /Policy SHA-256:/)
  assert.match(policyStaging, /Project:/)
  assert.match(policyStaging, /Session:/)
  assert.match(policyStaging, /'POLICY_STATED'/)
  assert.match(policyStaging, /denyHumanDraft/)
  assert.match(dispatch, /brief_override/)
  assert.match(dispatch, /bypass_cap: bypassCap/)
  assert.match(dispatch, /'DISPATCHED'/)
  assert.match(retry, /string\(inputs\.guidance, 'guidance'\)/)
  assert.match(retry, /'RETRY_REQUESTED'/)
  assert.match(tools, /required: \['id', 'policy_ref'\]/)
  assert.match(tools, /statePolicy,[\s\S]*dispatch,[\s\S]*retryWithGuidance/)
})

test('consequential actions use a visible project-bound human confirmation', async () => {
  const client = await source('../src/transport/client.ts')
  const store = await source('../src/store/mission-store.ts')
  const canvas = await source('../src/components/GraphCanvas.tsx')
  assert.match(client, /function requiredHumanAction/)
  for (const action of [
    "actions.add('approve')",
    "actions.add('reject')",
    "actions.add('dispatch')",
    "actions.add('pause')",
    "actions.add('resume')",
    "actions.add('structural')",
  ]) {
    assert.ok(client.includes(action), `missing human-presence gate: ${action}`)
  }
  assert.match(client, /\/action-drafts/)
  assert.match(client, /\/browser-sessions/)
  assert.match(client, /x-mg-capability-ref/)
  assert.match(client, /x-mg-nonce/)
  assert.match(client, /x-mg-session-proof/)
  assert.doesNotMatch(client, /sessionStorage/)
  assert.match(client, /Bound request SHA-256:/)
  assert.match(store, /humanConfirmation: HumanConfirmation \| null/)
  assert.match(store, /pending\.deny\?\.\(\)/)
  assert.match(canvas, /Human policy confirmation/)
  assert.match(canvas, /humanConfirmation\.text/)
  assert.match(canvas, /humanConfirmation\.details\.map/)
  assert.match(canvas, /humanConfirmation\.expiresAt/)
  assert.match(canvas, /denyHumanConfirmation\(\s*humanConfirmation\.id,\s*humanConfirmation\.textHash/)
  assert.match(canvas, /confirmHumanConfirmation\(\s*humanConfirmation\.id,\s*humanConfirmation\.textHash/)
  assert.match(store, /requireConfirmationSlot\(get\(\)\.humanConfirmation\)/)
  assert.match(store, /Confirmation changed; review the visible draft/)
})

test('confirmation metadata wraps without sharing the action row layout', async () => {
  const canvas = await source('../src/components/GraphCanvas.tsx')
  const styles = await source('../src/index.css')
  assert.equal(
    canvas.match(/className="structural-confirm-actions"/g)?.length,
    2,
  )
  assert.match(
    styles,
    /\.structural-confirm-plan \{[^}]*overflow-wrap: anywhere;/,
  )
  assert.match(styles, /\.structural-confirm-plan li \{[^}]*font-size: 10px;/)
  assert.match(styles, /\.structural-confirm-actions \{[^}]*display: flex;/)
  assert.doesNotMatch(styles, /\.structural-confirm > div \{/)
})

test('confirmation dialogs are named, described, focused, and escape-dismissible', async () => {
  const canvas = await source('../src/components/GraphCanvas.tsx')
  assert.equal(canvas.match(/aria-labelledby="confirmation-title"/g)?.length, 2)
  assert.equal(canvas.match(/aria-describedby="confirmation-description"/g)?.length, 2)
  assert.equal(canvas.match(/id="confirmation-title"/g)?.length, 2)
  assert.equal(canvas.match(/id="confirmation-description"/g)?.length, 2)
  assert.equal(canvas.match(/ref=\{confirmationCancelRef\}/g)?.length, 2)
  assert.match(canvas, /confirmationCancelRef\.current\?\.focus\(\)/)
  assert.match(canvas, /event\.key !== 'Escape'/)
  assert.match(canvas, /denyHumanConfirmation\(/)
  assert.match(canvas, /cancelStructural\(\)/)
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

test('mission bootstrap requests time out and loading hides fixture flight cards', async () => {
  const client = await source('../src/transport/client.ts')
  const canvas = await source('../src/components/GraphCanvas.tsx')
  const cloneDemo = client.slice(
    client.indexOf('async function cloneDemo()'),
    client.indexOf('function storedIdentity()'),
  )
  const snapshot = client.slice(
    client.indexOf('async function getSnapshot'),
    client.indexOf('async function issueBrowserSession'),
  )
  const browserSession = client.slice(
    client.indexOf('async function issueBrowserSession'),
    client.indexOf('function activeBrowserSession'),
  )
  assert.match(client, /const BOOTSTRAP_TIMEOUT_MS = 20_000/)
  for (const request of [cloneDemo, snapshot, browserSession]) {
    assert.match(request, /signal: AbortSignal\.timeout\(BOOTSTRAP_TIMEOUT_MS\)/)
  }
  assert.match(client, /catch \(error\) \{\s*enterFixtureWithRetry\(error\)/)
  assert.match(
    canvas,
    /connectionMode !== 'loading' && <FlightPanel now=\{correctedNow\} \/>/,
  )
})

test('WebMCP discovery starts in parallel with mission-client initialization', async () => {
  const app = await source('../src/App.tsx')
  const registry = await source('../src/webmcp/registry.ts')
  assert.match(
    app,
    /const missionClientInitialization = initializeMissionClient\(\)/,
  )
  assert.match(app, /\{ executionReady: missionClientInitialization \}/)
  assert.doesNotMatch(app, /initializeMissionClient\(\)\.then/)
  assert.match(registry, /await missionClientReadiness\(executionReady\)/)
  assert.match(registry, /'mission_connecting'/)
  assert.match(registry, /'mission_connection_failed'/)
})

test('late WebMCP activation updates the canvas and compatibility page reactively', async () => {
  const canvas = await source('../src/components/GraphCanvas.tsx')
  const compat = await source('../src/pages/CompatPage.tsx')
  assert.match(canvas, /useSyncExternalStore\(/)
  assert.match(canvas, /webMcpStatus\.state !== 'active'/)
  assert.match(compat, /useSyncExternalStore\(/)
  assert.match(compat, /await recheckWebMcp\(\)/)
  assert.match(compat, /status\.state === 'active' \? status\.namespace/)
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
  const clientLogic = await source('../src/transport/client-logic.ts')
  const pulse = await source('../src/components/PulseBar.tsx')
  assert.match(client, /searchParams\.set\('mg_project', candidate\.client\.project\)/)
  assert.match(client, /searchParams\.set\('mg_token', candidate\.client\.token\)/)
  assert.match(clientLogic, /documentRef\.execCommand\('copy'\)/)
  const copyText = clientLogic.slice(
    clientLogic.indexOf('export async function copyText'),
    clientLogic.indexOf('export function parseStoredIdentity'),
  )
  assert.match(copyText, /catch \{\s*return false/)
  assert.match(pulse, /disabled=\{connectionMode !== 'live'\}/)
  assert.match(pulse, /Start a fresh mission copy/)
  assert.match(pulse, /Open my stored mission/)
  assert.match(pulse, /connectionMode === 'fixture'/)
  assert.match(pulse, /Dev fixture projection/)
  assert.doesNotMatch(pulse, /connectionMessage\.includes\('fixture projection'\)/)
})

test('judge first-run prompts and WebMCP guidance are wired into the canvas', async () => {
  const canvas = await source('../src/components/GraphCanvas.tsx')
  const pulse = await source('../src/components/PulseBar.tsx')
  const styles = await source('../src/index.css')
  assert.match(canvas, /Ask your agent to catch you up on this mission/)
  assert.match(canvas, /Ask it to clear the approval queue under a policy you state/)
  assert.match(
    canvas,
    /Split the rate-limit task into config and enforcement halves — show me the blast radius first\./,
  )
  assert.match(canvas, /claimFirstRunPrompts\(projectId\)/)
  assert.match(canvas, /dismissFirstRunPrompts\(projectId\)/)
  assert.match(canvas, /copyText\(prompt\)/)
  assert.match(canvas, /className="agent-prompt-copy">Copy</)
  assert.match(canvas, /Copied — paste it to your agent/)
  assert.match(canvas, /}, 2_000\)/)
  assert.match(pulse, /aria-label="Show agent prompt suggestions"/)
  assert.doesNotMatch(
    styles,
    /first-run-prompts:not\(\.first-run-prompts--menu-open\) \{ display: none; \}/,
  )
  assert.match(styles, /\.first-run-prompts > div \{ display: grid; \}/)
  assert.match(canvas, /ChatGPT&apos;s built-in browser works natively/)
  assert.match(canvas, /Enable site tools/)
  assert.match(canvas, /chrome:\/\/flags\/#enable-webmcp-testing/)
  assert.match(canvas, /href="\/compat"/)
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

test('M5 split shares cursor-bound UI confirmation and recomputes its atomic batch', async () => {
  const tools = await source('../src/webmcp/tools.ts')
  const store = await source('../src/store/mission-store.ts')
  const client = await source('../src/transport/client.ts')
  const split = await source('../src/webmcp/split.ts')
  const confirmation = await source('../src/store/structural-confirmation.ts')
  assert.match(tools, /name: 'split_task'/)
  assert.match(tools, /prepareBatchMutation\(plan\.batch/)
  assert.match(tools, /stageStructural\(key, recompute\)/)
  assert.match(tools, /error:\s*\{\s*code: 'preview_stale'/)
  assert.match(store, /confirmStructuralToken\(key, opToken\)/)
  assert.match(store, /structuralConfirmation\.confirm\(/)
  assert.match(store, /blastRadius: getBlastRadius/)
  assert.match(confirmation, /pending\.opToken = this\.makeToken\(\)/)
  assert.match(confirmation, /pending\.apply = plan\.apply/)
  assert.match(confirmation, /const value = await pending\.apply\(\)/)
  assert.doesNotMatch(tools, /pausing\.map\([\s\S]*?'PAUSE_REQUESTED'/)
  assert.match(client, /export function prepareBatchMutation\(/)
  assert.match(split, /type: 'TASK_SPLIT'/)
  assert.match(split, /edge_remap: edgeRemap\.map/)
  assert.doesNotMatch(split, /type: 'EDGE_REMOVED'/)
  assert.match(split, /type: 'EDGE_ADDED'/)
  assert.match(tools, /proposal: \{\s*children: plan\.children\.map/)
  assert.match(tools, /edge_remap: result\.preview\.proposal\.edgeRemap\.map/)
})

test('M5 contextual registry updates all three tiers idempotently', async () => {
  const registry = await source('../src/webmcp/registry.ts')
  const dynamic = await source('../src/webmcp/dynamic-tools.ts')
  const tools = await source('../src/webmcp/tools.ts')
  assert.match(registry, /new DynamicToolController\(/)
  assert.match(registry, /useMissionStore\.subscribe/)
  assert.match(
    registry,
    /refreshContextualTools\(state\.selectedId !== previous\.selectedId\)/,
  )
  assert.match(dynamic, /this\.dynamicControllers\.delete\(name\)/)
  assert.match(dynamic, /this\.target\.provideContext/)
  assert.match(dynamic, /if \(this\.tier === 'none'\) return/)
  assert.match(dynamic, /const nextByName = new Map\(tools\.map/)
  assert.match(dynamic, /attempt <= this\.maxAttempts/)
  assert.match(registry, /contextual WebMCP tools degraded after 3/)
  assert.match(tools, /label: 'not_applicable'/)
  assert.match(tools, /contextualToolNamesForState\(/)
  assert.match(tools, /dispatchSelected,[\s\S]*explainSelected,[\s\S]*annotateSelected,[\s\S]*splitSelected,[\s\S]*reviewFailures/)
})

test('M5 visual wiring exposes blast radius, relayout, split ancestry, and pause state', async () => {
  const canvas = await source('../src/components/GraphCanvas.tsx')
  const card = await source('../src/components/TaskNodeCard.tsx')
  const inspector = await source('../src/components/Inspector.tsx')
  const store = await source('../src/store/mission-store.ts')
  const graph = await source('../src/model/graph.ts')
  assert.match(canvas, /mission-flow-node--relayouting/)
  assert.match(canvas, /structuralPreview\?\.blastRadius\.stale/)
  assert.match(card, /mission-node--preview-pausing/)
  assert.match(card, /mission-node--split-parent/)
  assert.match(inspector, /Open parent history/)
  assert.match(inspector, /previewNativeSplit/)
  assert.match(store, /case 'TASK_SPLIT'/)
  assert.match(store, /pause_requested: true/)
  assert.match(store, /pause_requested: false/)
  assert.match(graph, /parent_id: payload\.parent_id/)
  assert.match(canvas, /topologyRevision === scheduledRevision/)
  assert.match(canvas, /projectId === scheduledProjectId/)
  assert.match(canvas, /setLayoutRetry\(\(current\) => current \+ 1\)/)
})

test('canvas gates first paint and replays changes with visible cancellable pacing', async () => {
  const canvas = await source('../src/components/GraphCanvas.tsx')
  const pulse = await source('../src/components/PulseBar.tsx')
  const styles = await source('../src/index.css')
  assert.match(canvas, /const prelayout = layoutReadyFor\?\.projectId !== projectId/)
  assert.match(canvas, /setLayoutReadyFor\(\{ projectId: scheduledProjectId \}\)/)
  assert.match(canvas, /Promise\.race\(\[fitting, revealFallback\]\)/)
  assert.match(canvas, /duration: firstLayout \? 0 : 520/)
  assert.match(canvas, /canvas--prelayout/)
  assert.match(styles, /canvas--prelayout \.react-flow__node \{ pointer-events: none; opacity: 0; \}/)
  assert.match(styles, /canvas--prelayout \.mission-node--running::after \{ animation-play-state: paused; \}/)
  const replay = canvas.slice(
    canvas.indexOf('async function replayCatchUp()'),
    canvas.indexOf('async function copyMissionLink()'),
  )
  assert.match(replay, /async function replayCatchUp\(\) \{\s*cancelReplay\(\)/)
  assert.match(replay, /duration: reducedMotion \? 0 : 420/)
  assert.match(replay, /await waitForReplay\(420\)/)
  assert.match(replay, /await waitForReplay\(900\)/)
  assert.match(replay, /description: describeEvent\(event, nodes, edges\)/)
  assert.match(replay, /actor: replayActorLabel\(event\.actor\)/)
  assert.match(replay, /setReplayCaption\(\{ actor: step\.actor, description: step\.description \}\)/)
  assert.match(canvas, /canvas--replaying/)
  assert.match(canvas, /mission-flow-node--replay-focus/)
  assert.match(canvas, /className="replay-caption" role="status"/)
  assert.match(styles, /canvas--replaying \.react-flow__node,/)
  assert.match(styles, /mission-flow-node--replay-focus/)
  assert.match(styles, /\.replay-caption \{[^}]*position: absolute;/)
  assert.match(pulse, /Replaying changes · \$\{replayProgress\.step\}\/\$\{replayProgress\.total\}/)
  assert.match(canvas, /onPointerDownCapture=\{cancelReplay\}/)
  assert.match(canvas, /replayWaitCancel\.current\?\.\(\)/)
  assert.match(canvas, /setViewport\(getViewport\(\), \{ duration: 0 \}\)/)
  assert.doesNotMatch(pulse, /disabled=\{replaying\}/)
})

test('selection settling, project clearing, and cosmetic 409 handling preserve local intent', async () => {
  const store = await source('../src/store/mission-store.ts')
  const client = await source('../src/transport/client.ts')
  const selectionCase = store.slice(
    store.indexOf("case 'SELECTION_CHANGED':", store.indexOf('applyEvent(event)')),
    store.indexOf('\n    }', store.indexOf("case 'SELECTION_CHANGED':", store.indexOf('applyEvent(event)'))),
  )
  assert.match(store, /debounceKey: 'selection', staleMode: 'silent'/)
  assert.match(store, /if \(!mutationWasStale\(error\)\) reportMutationError/)
  assert.doesNotMatch(selectionCase, /selectedId\s*=/)
  assert.match(
    store,
    /selectedId:\s*projectChanged \|\| !selectedExists \? null : state\.selectedId/,
  )
  assert.match(client, /300,/)
  assert.match(client, /if \(context\.staleMode === 'error'\)/)
  assert.match(client, /await refreshSnapshot\(candidate\)/)
})

test('live fleet dispatch metadata, polling cleanup, and honest copy are wired', async () => {
  const client = await source('../src/transport/client.ts')
  const fleet = await source('../src/transport/fleet.ts')
  const tools = await source('../src/webmcp/tools.ts')
  const panel = await source('../src/components/FlightPanel.tsx')
  const app = await source('../src/App.tsx')
  const postMutation = client.slice(
    client.indexOf('async function postMutation<T'),
    client.indexOf('async function postMutationBatch'),
  )
  assert.match(client, /fleet-status/)
  assert.match(client, /fleet-requests/)
  assert.match(client, /void liveFleet\.dispatch\(dispatched\.node_id\)/)
  assert.ok(
    postMutation.indexOf('void liveFleet.dispatch(dispatched.node_id)') <
      postMutation.indexOf('await waitForSequence(result.seq, context)'),
  )
  assert.match(client, /liveFleet\.noteLedgerEvent\(data\.event\)/)
  assert.match(tools, /fleetResultForDispatch\(id\)/)
  assert.doesNotMatch(tools, /await fleetResultForDispatch\(id\)/)
  assert.match(tools, /withFleetMetadata/)
  assert.match(panel, /liveFleetDisplayText\(liveFleet\)/)
  assert.match(fleet, /10_000/)
  assert.match(fleet, /Live fleet: queued/)
  assert.match(fleet, /Live fleet: worker starting/)
  assert.match(
    fleet,
    /The shared live fleet is busy right now — live execution is demonstrated in the video\./,
  )
  assert.match(app, /return unmountLiveFleet/)
})

test('lineage folds and remap dossiers do not depend on bounded event history', async () => {
  const store = await source('../src/store/mission-store.ts')
  const tools = await source('../src/webmcp/tools.ts')
  const inspector = await source('../src/components/Inspector.tsx')
  assert.match(store, /parentByChild/)
  assert.match(store, /foldTaskSplit\(nodes, edges, event\.payload\)/)
  assert.match(store, /foldEdgeLineage\(/)
  assert.match(store, /pruneEdgeLineage\(/)
  assert.match(tools, /const splitParent = task\.parent_id/)
  assert.match(tools, /state\.annotations\[id\] \?\? \[\]/)
  assert.match(tools, /\{ target_id: targetId, note \}/)
  assert.match(inspector, /runtimeNode\?\.parent_id/)
  assert.match(inspector, /annotations\[edge\.edge_id\] \?\? \[\]/)
  assert.doesNotMatch(tools, /event\.payload\.children\.some\(\(child\) => child\.id === id\)/)
})
