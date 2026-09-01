const submissionId = 'sub-eval-001'
const commitSha = '0123456789abcdef0123456789abcdef01234567'

const stateOutput = document.querySelector('#state')
const runtimeStatus = document.querySelector('#runtime-status')
const signButton = document.querySelector('#sign')
const resetButton = document.querySelector('#reset')
const registrationLifecycle = new AbortController()

async function responseJson(response) {
  const body = await response.json()
  await refreshState()
  return body
}

async function get(path, signal) {
  return responseJson(await fetch(path, { signal, cache: 'no-store' }))
}

async function post(path, body, signal) {
  return responseJson(
    await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
  )
}

async function refreshState() {
  const response = await fetch('/api/state', { cache: 'no-store' })
  const state = await response.json()
  stateOutput.textContent = JSON.stringify(state, null, 2)
  signButton.disabled = state.phase !== 'awaiting_signature'
}

function inputObject(value) {
  if (typeof value === 'string') return JSON.parse(value)
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value
  throw new Error('Tool input must be an object or a JSON object string.')
}

function signalFrom(options) {
  return options && options.signal instanceof AbortSignal ? options.signal : undefined
}

const tools = [
  {
    name: 'submission',
    description:
      'Read the signed submission decision and atomically claim its exact synthetic commit once.',
    inputSchema: {
      type: 'object',
      properties: {
        submission_id: { type: 'string', const: submissionId },
        commit_sha: { type: 'string', const: commitSha },
        claim: { const: true },
      },
      required: ['submission_id', 'commit_sha', 'claim'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    async execute(inputs, options) {
      const body = await post('/api/submission', inputObject(inputs), signalFrom(options))
      return JSON.stringify(body)
    },
  },
  {
    name: 'report',
    description:
      'Read the accepted submission report, including signature attribution and claimed commit.',
    inputSchema: {
      type: 'object',
      properties: { report_id: { type: 'string' } },
      required: ['report_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(inputs, options) {
      const { report_id: reportId } = inputObject(inputs)
      if (typeof reportId !== 'string' || reportId === '') throw new Error('report_id is required.')
      const body = await get(`/api/report/${encodeURIComponent(reportId)}`, signalFrom(options))
      return JSON.stringify(body)
    },
  },
  {
    name: 'day_book',
    description:
      'Read whether the report-linked day-book entry exists and return its exact identity.',
    inputSchema: {
      type: 'object',
      properties: { entry_id: { type: 'string' } },
      required: ['entry_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(inputs, options) {
      const { entry_id: entryId } = inputObject(inputs)
      if (typeof entryId !== 'string' || entryId === '') throw new Error('entry_id is required.')
      const body = await get(`/api/day-book/${encodeURIComponent(entryId)}`, signalFrom(options))
      return JSON.stringify(body)
    },
  },
]

async function registerTools() {
  const modelContext = document.modelContext ?? navigator.modelContext
  if (!modelContext) {
    runtimeStatus.dataset.state = 'missing'
    runtimeStatus.textContent = 'unavailable — use a native WebMCP browser'
    return
  }
  try {
    for (const tool of tools) {
      await Promise.resolve(
        modelContext.registerTool(tool, { signal: registrationLifecycle.signal }),
      )
    }
    runtimeStatus.dataset.state = 'ready'
    runtimeStatus.textContent = `${tools.length} tools registered`
  } catch {
    registrationLifecycle.abort()
    runtimeStatus.dataset.state = 'missing'
    runtimeStatus.textContent = 'registration failed — inspect browser compatibility'
  }
}

signButton.addEventListener('click', async () => {
  await post('/api/sign', {})
})

resetButton.addEventListener('click', async () => {
  await post('/api/reset', { mode: 'awaiting' })
})

window.addEventListener('pagehide', () => registrationLifecycle.abort(), { once: true })

await refreshState()
await registerTools()
