import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { foldTaskSplit } from '../src/model/graph.ts'
import { StructuralConfirmationController } from '../src/store/structural-confirmation.ts'
import { buildSplitPlan } from '../src/webmcp/split.ts'

const serverDirectory = fileURLToPath(new URL('../../server/', import.meta.url))

function task(id, title) {
  return {
    id,
    title,
    brief: `${title} brief.`,
    estimate_min: 10,
    tags: [],
    state: 'queued',
  }
}

async function availablePort() {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  assert.ok(address && typeof address === 'object')
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}

async function startServer() {
  const scratch = await mkdtemp(join(tmpdir(), 'missiongraph-app-split-'))
  const port = await availablePort()
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/http.ts'], {
    cwd: serverDirectory,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: join(scratch, 'missiongraph.sqlite'),
      REPORTER_TOKEN: 'app-real-server-regression',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000)
  })
  const baseUrl = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before readiness (${child.exitCode}): ${stderr}`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/clone-demo`, {
        method: 'POST',
      })
      if (response.ok) {
        return {
          baseUrl,
          child,
          identity: await response.json(),
          scratch,
        }
      }
    } catch {
      // The child has not bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`server did not become ready: ${stderr}`)
}

async function stopServer(server) {
  if (server.child.exitCode === null) {
    server.child.kill('SIGTERM')
    let killTimer
    const killTimeout = new Promise((resolve) => {
      killTimer = setTimeout(() => resolve(false), 2_000)
      killTimer.unref()
    })
    const exited = await Promise.race([
      once(server.child, 'exit').then(() => true),
      killTimeout,
    ])
    clearTimeout(killTimer)
    if (!exited && server.child.exitCode === null) {
      server.child.kill('SIGKILL')
      await once(server.child, 'exit')
    }
  }
  await rm(server.scratch, { recursive: true, force: true })
}

function clientGraph(snapshot) {
  const parents = new Map()
  Object.values(snapshot.state.nodes).forEach((node) => {
    if (node.record_type === 'group') {
      node.child_ids.forEach((childId) => parents.set(childId, node.id))
    }
  })
  return {
    nodes: Object.values(snapshot.state.nodes).map((node) => ({
      ...node,
      ...(parents.has(node.id) ? { parent_id: parents.get(node.id) } : {}),
    })),
    edges: Object.values(snapshot.state.edges).map((edge) => ({
      edge_id: edge.id,
      upstream: edge.upstream,
      downstream: edge.downstream,
      kind: edge.kind,
    })),
  }
}

function byId(values, key) {
  return Object.fromEntries(
    [...values]
      .sort((left, right) => left[key].localeCompare(right[key]))
      .map((value) => [value[key], value]),
  )
}

function foldNode(node) {
  const folded = { ...node }
  delete folded.availability
  delete folded.ready_since
  return folded
}

async function eventsSince(baseUrl, project, token, cursor, count) {
  const url = new URL('/sse', baseUrl)
  url.searchParams.set('project', project)
  url.searchParams.set('token', token)
  url.searchParams.set('from_seq', String(cursor))
  const response = await fetch(url)
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffered = ''
  try {
    while (events.length < count) {
      const chunk = await reader.read()
      assert.equal(chunk.done, false, 'SSE ended before replaying batch events')
      buffered += decoder.decode(chunk.value, { stream: true })
      const frames = buffered.split('\n\n')
      buffered = frames.pop()
      for (const frame of frames) {
        const data = frame
          .split('\n')
          .find((line) => line.startsWith('data: '))
        if (!data) continue
        const message = JSON.parse(data.slice('data: '.length))
        if (message.kind === 'event') events.push(message.event)
      }
    }
  } finally {
    await reader.cancel()
  }
  return events.slice(0, count)
}

test(
  'real server accepts a re-previewed split and preserves concurrent incident edges',
  { timeout: 15_000 },
  async () => {
    const server = await startServer()
    try {
      const { project, token } = server.identity
      const sessionResponse = await fetch(
        `${server.baseUrl}/api/p/${project}/browser-sessions`,
        {
          method: 'POST',
          headers: { 'x-mg-token': token },
        },
      )
      const session = await sessionResponse.json()
      assert.equal(sessionResponse.status, 200, JSON.stringify(session))
      const headers = {
        'content-type': 'application/json',
        'x-mg-token': token,
        'x-mg-session': session.session_id,
        'x-mg-session-proof': session.session_proof,
      }
      let cursor = 0
      const mutate = async (type, payload, idemKey) => {
        const response = await fetch(
          `${server.baseUrl}/api/p/${project}/agent-mutations`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              type,
              payload,
              idem_key: idemKey,
              base_seq: cursor,
            }),
          },
        )
        const body = await response.json()
        assert.equal(response.status, 200, JSON.stringify(body))
        cursor = body.seq
      }
      const snapshot = async () => {
        const response = await fetch(
          `${server.baseUrl}/api/p/${project}/snapshot`,
          { headers: { 'x-mg-token': token } },
        )
        assert.equal(response.status, 200)
        return response.json()
      }

      await mutate('TASK_ADDED', { node: task('upstream', 'Upstream') }, 'add-upstream')
      await mutate('TASK_ADDED', { node: task('parent', 'Parent') }, 'add-parent')
      await mutate('TASK_ADDED', { node: task('downstream', 'Downstream') }, 'add-downstream')
      await mutate(
        'EDGE_ADDED',
        {
          edge_id: 'incoming',
          upstream: 'upstream',
          downstream: 'parent',
          kind: 'depends',
        },
        'add-incoming',
      )

      let graph = clientGraph(await snapshot())
      const subtasks = [
        {
          temp_id: 'entry',
          title: 'Parent entry',
          brief: 'Start the parent work.',
          estimate: 4,
          tags: [],
          deps: [],
        },
        {
          temp_id: 'terminal',
          title: 'Parent terminal',
          brief: 'Finish the parent work.',
          estimate: 6,
          tags: [],
          deps: ['entry'],
        },
      ]
      let tokenNumber = 0
      const plans = []
      const controller = new StructuralConfirmationController(
        () => `operation-${++tokenNumber}`,
      )
      const recompute = () => {
        const parent = graph.nodes.find((node) => node.id === 'parent')
        const plan = buildSplitPlan(parent, subtasks, graph.edges)
        plans.push(plan)
        const planCursor = cursor
        const titles = new Map(
          [...graph.nodes, ...plan.children].map((node) => [node.id, node.title]),
        )
        return {
          title: 'Split Parent',
          ids: ['parent'],
          proposal: {
            children: plan.children.map(({ id, title }) => ({ id, title })),
            edgeRemap: plan.edgeRemap.map((remap) => ({
              edgeId: remap.edgeId,
              upstream: remap.upstream,
              upstreamTitle: titles.get(remap.upstream),
              downstream: remap.downstream,
              downstreamTitle: titles.get(remap.downstream),
              kind: remap.kind,
            })),
          },
          apply: async () => {
            const staged = await fetch(
              `${server.baseUrl}/api/p/${project}/action-drafts`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  mutation: { batch: plan.batch },
                  summary: 'Apply the reviewed split blast radius.',
                }),
              },
            )
            const draft = await staged.json()
            assert.equal(staged.status, 200, JSON.stringify(draft))
            const confirmed = await fetch(
              `${server.baseUrl}/api/p/${project}/action-drafts/${draft.draft_id}/confirm`,
              {
                method: 'POST',
                headers: {
                  'x-mg-token': token,
                  'x-mg-session': session.session_id,
                  'x-mg-session-proof': session.session_proof,
                },
              },
            )
            const capability = await confirmed.json()
            assert.equal(confirmed.status, 200, JSON.stringify(capability))
            const response = await fetch(
              `${server.baseUrl}/api/p/${project}/agent-mutations`,
              {
                method: 'POST',
                headers: {
                  ...headers,
                  'x-mg-capability-ref': capability.capability_ref,
                  'x-mg-capability': capability.capability,
                  'x-mg-nonce': `split-${planCursor}`,
                },
                body: JSON.stringify({
                  batch: plan.batch,
                  idem_key: `split-${planCursor}`,
                  base_seq: planCursor,
                }),
              },
            )
            const body = await response.json()
            assert.equal(response.status, 200, JSON.stringify(body))
            cursor = body.seqs.at(-1)
            return { plan, seqs: body.seqs }
          },
        }
      }
      const preview = controller.stage({
        key: 'split:parent',
        cursor: String(cursor),
        projectId: project,
        recompute,
      })
      const firstChildIds = preview.proposal.children.map((child) => child.id)

      await mutate(
        'EDGE_ADDED',
        {
          edge_id: 'concurrent',
          upstream: 'parent',
          downstream: 'downstream',
          kind: 'depends',
        },
        'add-concurrent',
      )
      const beforeSplit = await snapshot()
      graph = clientGraph(beforeSplit)
      const stale = await controller.confirm(
        preview.key,
        preview.opToken,
        { cursor: String(cursor), projectId: project },
        () => ({ cursor: String(cursor), projectId: project }),
        () => false,
      )
      assert.equal(stale.applied, false)
      assert.notDeepEqual(
        stale.operation.proposal.children.map((child) => child.id),
        firstChildIds,
      )
      assert.deepEqual(
        stale.operation.proposal.children.map((child) => child.title),
        ['Parent entry', 'Parent terminal'],
      )
      assert.deepEqual(
        stale.operation.proposal.edgeRemap
          .map((remap) => remap.edgeId)
          .sort(),
        ['concurrent', 'incoming'],
      )

      const beforeBatchCursor = cursor
      const confirmed = await controller.confirm(
        preview.key,
        stale.operation.opToken,
        { cursor: String(cursor), projectId: project },
        () => ({ cursor: String(cursor), projectId: project }),
        () => false,
      )
      assert.equal(confirmed.applied, true)
      assert.deepEqual(
        confirmed.value.plan.children.map((child) => child.id),
        stale.operation.proposal.children.map((child) => child.id),
      )

      const finalSnapshot = await snapshot()
      const finalGraph = clientGraph(finalSnapshot)
      const entry = finalGraph.nodes.find((node) => node.title === 'Parent entry')
      const terminal = finalGraph.nodes.find(
        (node) => node.title === 'Parent terminal',
      )
      assert.ok(entry)
      assert.ok(terminal)
      assert.deepEqual(finalSnapshot.state.edges.incoming, {
        id: 'incoming',
        upstream: 'upstream',
        downstream: entry.id,
        kind: 'depends',
      })
      assert.deepEqual(finalSnapshot.state.edges.concurrent, {
        id: 'concurrent',
        upstream: terminal.id,
        downstream: 'downstream',
        kind: 'depends',
      })

      const events = await eventsSince(
        server.baseUrl,
        project,
        token,
        beforeBatchCursor,
        confirmed.value.seqs.length,
      )
      assert.deepEqual(
        events.map((event) => event.type),
        ['TASK_SPLIT', 'EDGE_ADDED'],
      )
      assert.ok(
        events
          .filter((event) => event.type === 'EDGE_ADDED')
          .every(
            (event) =>
              event.payload.edge_id !== 'incoming' &&
              event.payload.edge_id !== 'concurrent',
          ),
      )

      let folded = clientGraph(beforeSplit)
      for (const event of events) {
        if (event.type === 'TASK_SPLIT') {
          folded = foldTaskSplit(folded.nodes, folded.edges, event.payload)
        } else if (event.type === 'EDGE_ADDED') {
          folded.edges.push({
            edge_id: event.payload.edge_id,
            upstream: event.payload.upstream,
            downstream: event.payload.downstream,
            kind: event.payload.kind,
          })
        }
      }
      assert.deepEqual(
        byId(folded.nodes.map(foldNode), 'id'),
        byId(finalGraph.nodes.map(foldNode), 'id'),
      )
      assert.deepEqual(
        byId(folded.edges, 'edge_id'),
        byId(finalGraph.edges, 'edge_id'),
      )
      assert.equal(cursor, Number(finalSnapshot.cursor))
      assert.equal(plans.length, 2)
    } finally {
      await stopServer(server)
    }
  },
)
