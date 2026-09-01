import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  capabilityRequiredNextStep,
  policyConfirmationNextStep,
} from '../src/webmcp/agent-guidance.ts'
import {
  CONTENT_POLICY,
  contentSafeAnnotations,
  contentSafeEnvelope,
} from '../src/webmcp/content-policy.ts'
import { DynamicToolController } from '../src/webmcp/dynamic-tools.ts'
import { addTaskWithDependencies } from '../src/webmcp/task-mutations.ts'
import { buildSplitPlan } from '../src/webmcp/split.ts'

const toolsSource = readFileSync(
  new URL('../src/webmcp/tools.ts', import.meta.url),
  'utf8',
)
const registrySource = readFileSync(
  new URL('../src/webmcp/registry.ts', import.meta.url),
  'utf8',
)

const splitParent = {
  id: 'parent',
  title: 'Parent',
  brief: 'Split this task.',
  estimate_min: 30,
  tags: [],
  state: 'running',
}

function splitPlan(subtasks, edges) {
  let id = 0
  return buildSplitPlan(splitParent, subtasks, edges, () => `generated-${++id}`)
}

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

test('add_task submits the task and every dependency through one atomic batch', async () => {
  const calls = []
  const confirmationRequired = Object.assign(new Error('Confirm this batch.'), {
    code: 'confirmation_required',
  })
  const fakeTransport = async (batch, options) => {
    calls.push({ batch, options })
    throw confirmationRequired
  }
  const task = {
    id: 'new-task',
    title: 'New task',
    brief: 'Do all of it.',
    estimate_min: 15,
    tags: ['freeze'],
    state: 'queued',
  }
  let edge = 0

  await assert.rejects(
    addTaskWithDependencies(
      task,
      ['started-a', 'started-b'],
      fakeTransport,
      () => `edge-${++edge}`,
    ),
    (error) => error === confirmationRequired,
  )
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    options: { actor: 'browser_agent' },
    batch: [
      { type: 'TASK_ADDED', payload: { node: task } },
      {
        type: 'EDGE_ADDED',
        payload: {
          edge_id: 'edge-1',
          upstream: 'started-a',
          downstream: 'new-task',
          kind: 'depends',
        },
      },
      {
        type: 'EDGE_ADDED',
        payload: {
          edge_id: 'edge-2',
          upstream: 'started-b',
          downstream: 'new-task',
          kind: 'depends',
        },
      },
    ],
  })
})

test('split preserves linear incident-edge rewiring without clones', () => {
  const plan = splitPlan(
    [
      { temp_id: 'first', title: 'First', brief: 'First.', estimate: 10, tags: [], deps: [] },
      { temp_id: 'last', title: 'Last', brief: 'Last.', estimate: 20, tags: [], deps: ['first'] },
    ],
    [
      { edge_id: 'incoming', upstream: 'before', downstream: 'parent', kind: 'depends' },
      { edge_id: 'outgoing', upstream: 'parent', downstream: 'after', kind: 'depends' },
    ],
  )
  const added = plan.batch.filter((item) => item.type === 'EDGE_ADDED')

  assert.equal(plan.edgeRemap.length, 2)
  assert.deepEqual(plan.batch[0].payload.edge_remap, [
    { edge_id: 'incoming', new_target: plan.entryIds[0] },
    { edge_id: 'outgoing', new_target: plan.terminalIds[0] },
  ])
  assert.equal(added.length, 1)
  assert.equal(added[0].payload.upstream, plan.entryIds[0])
  assert.equal(added[0].payload.downstream, plan.terminalIds[0])
})

test('split rewires every parallel entry, terminal, and conflict target', () => {
  const plan = splitPlan(
    [
      { temp_id: 'left', title: 'Left', brief: 'Left.', estimate: 10, tags: [], deps: [] },
      { temp_id: 'right', title: 'Right', brief: 'Right.', estimate: 10, tags: [], deps: [] },
    ],
    [
      { edge_id: 'incoming', upstream: 'before', downstream: 'parent', kind: 'depends' },
      { edge_id: 'outgoing', upstream: 'parent', downstream: 'after', kind: 'depends' },
      { edge_id: 'conflict', upstream: 'parent', downstream: 'rival', kind: 'conflicts' },
    ],
  )
  const resulting = plan.edgeRemap.map(({ upstream, downstream, kind }) => ({
    upstream,
    downstream,
    kind,
  }))

  assert.deepEqual(
    resulting.filter((edge) => edge.upstream === 'before'),
    plan.entryIds.map((downstream) => ({
      upstream: 'before',
      downstream,
      kind: 'depends',
    })),
  )
  assert.deepEqual(
    resulting.filter((edge) => edge.downstream === 'after'),
    plan.terminalIds.map((upstream) => ({
      upstream,
      downstream: 'after',
      kind: 'depends',
    })),
  )
  assert.deepEqual(
    resulting.filter((edge) => edge.downstream === 'rival'),
    plan.children.map((child) => ({
      upstream: child.id,
      downstream: 'rival',
      kind: 'conflicts',
    })),
  )
  assert.equal(plan.batch[0].payload.edge_remap.length, 3)
  assert.equal(
    plan.batch.filter((item) => item.type === 'EDGE_ADDED').length,
    3,
  )
  assert.equal(plan.edgeRemap.length, 6)
})

test('split fans prerequisites into three children while sharing one terminal', () => {
  const plan = splitPlan(
    [
      { temp_id: 'left', title: 'Left', brief: 'Left.', estimate: 5, tags: [], deps: [] },
      { temp_id: 'right', title: 'Right', brief: 'Right.', estimate: 5, tags: [], deps: [] },
      { temp_id: 'join', title: 'Join', brief: 'Join.', estimate: 5, tags: [], deps: ['left', 'right'] },
    ],
    [
      { edge_id: 'incoming', upstream: 'before', downstream: 'parent', kind: 'depends' },
      { edge_id: 'outgoing', upstream: 'parent', downstream: 'after', kind: 'depends' },
    ],
  )

  assert.equal(plan.entryIds.length, 2)
  assert.equal(plan.terminalIds.length, 1)
  assert.deepEqual(
    plan.edgeRemap
      .filter((edge) => edge.upstream === 'before')
      .map((edge) => edge.downstream),
    plan.entryIds,
  )
  assert.deepEqual(
    plan.edgeRemap
      .filter((edge) => edge.downstream === 'after')
      .map((edge) => edge.upstream),
    plan.terminalIds,
  )
  assert.equal(plan.edgeRemap.length, 3)
  assert.equal(
    plan.batch.filter((item) => item.type === 'EDGE_ADDED').length,
    3,
  )
})

test('running split notice describes the deferred idle-thread re-brief', () => {
  assert.match(
    toolsSource,
    /The split is recorded and the graph rewired; the running worker keeps its original brief until it exits, after which the supervisor can re-brief the idle thread\./,
  )
  assert.doesNotMatch(
    toolsSource,
    /supervisor will re-brief its worker after the split/,
  )
})

test('policy handshake next steps name the exact follow-up calls and references', () => {
  assert.equal(
    policyConfirmationNextStep('42'),
    'Ask the human to confirm in the page, then call graph_digest with cursor 42; the POLICY_STATED entry carries policy_ref — draft_id is not a policy_ref.',
  )
  assert.equal(
    capabilityRequiredNextStep('approve', '43'),
    'Call state_policy with the human-stated policy text. Ask the human to confirm it in the page, then call graph_digest with cursor 43; read POLICY_STATED.policy_ref and call approve again with that policy_ref. draft_id is not a policy_ref.',
  )
  assert.equal(
    capabilityRequiredNextStep('dispatch', '44'),
    'Call list_ready, then call dispatch with a ready task id. Ask the human to confirm the staged dispatch in the page, then call graph_digest with cursor 44 to verify the DISPATCHED entry.',
  )
  assert.equal(capabilityRequiredNextStep('reject', '45'), undefined)
  assert.match(toolsSource, /next_step: policyConfirmationNextStep/)
  assert.match(toolsSource, /human_presence: \{[\s\S]*pending:/)
  for (const tool of ['state_policy', 'approve', 'dispatch', 'list_ready', 'split_task']) {
    const start = toolsSource.indexOf(`name: '${tool}'`)
    const description = toolsSource.slice(start, start + 700)
    assert.match(description, /description:/)
    assert.match(description, /Precondition|No precondition/)
  }
})

test('list_ready returns client-estimated path distance in live and fixture modes', () => {
  const start = toolsSource.indexOf("name: 'list_ready'")
  const listReadySource = toolsSource.slice(
    start,
    toolsSource.indexOf("name: 'list_pending_approvals'", start),
  )

  assert.match(listReadySource, /remaining_path_min: remainingPath/)
  assert.match(listReadySource, /slack_min: critical\.eta - remainingPath/)
  assert.match(
    listReadySource,
    /projection: 'client estimate against the server critical path'/,
  )
  assert.doesNotMatch(
    listReadySource,
    /connectionMode === 'fixture'[\s\S]*remaining_path_min/,
  )
})

test('contextual registration observes selection changes during delayed initial registration', async () => {
  const active = new Set()
  let releaseInitial
  const modelContext = {
    async registerTool(tool, options = {}) {
      if (tool.name === 'selected-a') {
        await new Promise((resolve) => {
          releaseInitial = resolve
        })
      }
      if (options.signal?.aborted) return
      active.add(tool.name)
      options.signal?.addEventListener(
        'abort',
        () => active.delete(tool.name),
        { once: true },
      )
    },
  }
  const controller = new DynamicToolController(
    modelContext,
    'abort-controller',
    [],
  )
  let selected = 'selected-a'
  const listeners = new Set()
  const unsubscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const reconcile = () => controller.update([{ name: selected }], true)

  const removeSubscription = unsubscribe(() => void reconcile())
  const initial = reconcile()
  while (!releaseInitial) await Promise.resolve()
  selected = 'selected-b'
  listeners.forEach((listener) => listener())
  releaseInitial()
  await initial
  await reconcile()

  assert.deepEqual([...active], ['selected-b'])
  const subscribeAt = registrySource.indexOf(
    'const nextUnsubscribeContext = useMissionStore.subscribe',
  )
  const initialUpdateAt = registrySource.indexOf(
    'await nextDynamicController.update',
    subscribeAt,
  )
  const reconciliationAt = registrySource.indexOf(
    'await refreshContextualTools(true)',
    initialUpdateAt,
  )
  assert.ok(subscribeAt > -1 && subscribeAt < initialUpdateAt)
  assert.ok(initialUpdateAt < reconciliationAt)

  removeSubscription()
  await controller.dispose()
})
