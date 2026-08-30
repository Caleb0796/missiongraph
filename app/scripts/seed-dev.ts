import { shortyEvents } from '../src/fixtures/shorty-dag.ts'
import type { MissionEvent } from '../src/model/types.ts'

const server = (
  process.env.MG_SERVER ??
  process.env.VITE_MG_SERVER ??
  'http://127.0.0.1:31337'
).replace(/\/$/, '')
const session = crypto.randomUUID()

const browserMutationTypes = new Set([
  'TASK_ADDED',
  'TASK_REMOVED',
  'TASK_SPLIT',
  'EDGE_ADDED',
  'EDGE_REMOVED',
  'DISPATCHED',
  'RETRY_REQUESTED',
  'PAUSE_REQUESTED',
  'RESUME_REQUESTED',
  'APPROVED',
  'REJECTED',
  'POLICY_STATED',
  'ANNOTATED',
  'JOURNAL_NOTE',
  'NODE_MOVED',
  'SELECTION_CHANGED',
])

async function json<T>(response: Response): Promise<T> {
  const body = await response.json()
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(body)}`)
  }
  return body as T
}

const clone = await json<{ project: string; token: string; cursor: string }>(
  await fetch(`${server}/api/clone-demo`, { method: 'POST' }),
)
const initial = await json<{ state: { nodes: Record<string, unknown> } }>(
  await fetch(`${server}/api/p/${clone.project}/snapshot`, {
    headers: { 'x-mg-token': clone.token },
  }),
)

if (Object.keys(initial.state.nodes).length > 0) {
  throw new Error(
    'The cloned dev project is not blank. Start the server with an empty demo-seed before running seed:dev.',
  )
}

let cursor = Number(clone.cursor)
for (const event of shortyEvents.filter((candidate) =>
  browserMutationTypes.has(candidate.type),
)) {
  const response = await json<{ seq: number }>(
    await fetch(`${server}/api/p/${clone.project}/mutations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mg-token': clone.token,
        'x-mg-session': session,
        'x-mg-actor': event.actor === 'browser_agent' ? 'browser_agent' : 'human',
      },
      body: JSON.stringify({
        type: event.type,
        payload: (event as MissionEvent).payload,
        idem_key: crypto.randomUUID(),
        base_seq: cursor,
      }),
    }),
  )
  cursor = response.seq
}

const finalSnapshot = await json<{
  state: {
    nodes: Record<string, { state: string }>
    edges: Record<string, unknown>
  }
  cursor: string
}>(
  await fetch(`${server}/api/p/${clone.project}/snapshot`, {
    headers: { 'x-mg-token': clone.token },
  }),
)
const states = Object.values(finalSnapshot.state.nodes).reduce<Record<string, number>>(
  (counts, node) => ({ ...counts, [node.state]: (counts[node.state] ?? 0) + 1 }),
  {},
)
if (
  Object.keys(finalSnapshot.state.nodes).length !== 14 ||
  Object.keys(finalSnapshot.state.edges).length !== 18 ||
  finalSnapshot.cursor !== String(cursor)
) {
  throw new Error('The seeded live projection does not match the Shorty graph.')
}

const url = new URL(process.env.MG_APP_URL ?? 'http://127.0.0.1:5173/')
url.searchParams.set('mg_project', clone.project)
url.searchParams.set('mg_token', clone.token)

process.stdout.write(
  [
    `Seeded ${shortyEvents.filter((event) => browserMutationTypes.has(event.type)).length} real mutation events at cursor ${cursor}.`,
    `Verified 14 tasks, 18 edges, and lifecycle states ${JSON.stringify(states)} from the live snapshot.`,
    `Open ${url.toString()}`,
    'Reporter-only fixture records were not imported; they remain simulation data and are not represented as real worker history.',
  ].join('\n') + '\n',
)
