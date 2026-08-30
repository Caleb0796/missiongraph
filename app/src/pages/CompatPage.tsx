import { useEffect, useState } from 'react'
import {
  getWebMcpRuntime,
  initializeWebMcp,
  type RegistryStatus,
} from '../webmcp/registry'

function formatRaw(value: unknown) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function CompatPage() {
  const [status, setStatus] = useState<RegistryStatus | null>(null)
  const [rawResult, setRawResult] = useState('No self-test run yet.')
  const [running, setRunning] = useState(false)

  useEffect(() => {
    void initializeWebMcp()
      .then(setStatus)
      .catch((error) => setRawResult(formatRaw(error)))
  }, [])

  async function getTools() {
    setRunning(true)
    try {
      await initializeWebMcp()
      const runtime = getWebMcpRuntime()
      if (!runtime) throw new Error('WebMCP modelContext is unavailable.')
      setRawResult(formatRaw(await runtime.modelContext.getTools()))
    } catch (error) {
      setRawResult(formatRaw(error))
    } finally {
      setRunning(false)
    }
  }

  async function executeHello() {
    setRunning(true)
    try {
      await initializeWebMcp()
      const runtime = getWebMcpRuntime()
      if (!runtime) throw new Error('WebMCP modelContext is unavailable.')
      const tools = await runtime.modelContext.getTools()
      const helloTool = tools.find((tool) => tool.name === 'hello_missiongraph')
      if (!helloTool) throw new Error('hello_missiongraph was not found by getTools().')
      setRawResult(formatRaw(await runtime.modelContext.executeTool(helloTool, '{}')))
    } catch (error) {
      setRawResult(formatRaw(error))
    } finally {
      setRunning(false)
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100">
      <div className="mx-auto max-w-3xl">
        <a href="/" className="mb-10 inline-flex text-sm text-cyan-300 hover:text-cyan-200">
          ← Return to MissionGraph
        </a>
        <p className="mb-3 font-mono text-sm tracking-[0.22em] text-cyan-300 uppercase">
          MissionGraph M0
        </p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          WebMCP compatibility spike
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-300">
          This page registers one read-only tool and exposes direct discovery and
          execution checks before any browser agent is involved.
        </p>

        {!getWebMcpRuntime() && (
          <section className="mt-8 rounded-xl border border-amber-400/40 bg-amber-400/10 p-5 text-amber-100">
            <h2 className="font-semibold">WebMCP is not enabled</h2>
            <p className="mt-1 text-sm leading-6">
              Enable chrome://flags/#enable-webmcp-testing or open in ChatGPT&apos;s browser.
            </p>
          </section>
        )}

        <section className="mt-8 grid gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-5 text-sm sm:grid-cols-2">
          <div>
            <p className="text-slate-400">API namespace</p>
            <p className="mt-1 font-mono text-cyan-200">
              {status?.namespace ?? 'none detected'}
            </p>
          </div>
          <div>
            <p className="text-slate-400">Dynamic-tools tier</p>
            <p className="mt-1 font-mono text-cyan-200">
              {status?.dynamicToolsTier ?? 'none detected'}
            </p>
          </div>
        </section>

        <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/70 p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">In-page self-test</h2>
              <p className="mt-1 text-sm text-slate-400">
                Calls getTools(), then executeTool() for hello_missiongraph.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={getTools} disabled={running} className="compat-button">
                Get tools
              </button>
              <button type="button" onClick={executeHello} disabled={running} className="compat-button compat-button--primary">
                Execute hello
              </button>
            </div>
          </div>
          <pre className="mt-5 min-h-44 overflow-x-auto rounded-lg bg-slate-950 p-4 text-left font-mono text-xs leading-6 whitespace-pre-wrap text-emerald-300">
            {rawResult}
          </pre>
        </section>

        <section className="mt-6 rounded-xl border border-slate-800 p-5 text-sm leading-6 text-slate-400">
          <h2 className="font-semibold text-slate-200">Expected hello result</h2>
          <code className="mt-2 block break-all text-cyan-200">
            {'{ok:true, ts, env:{ua, api}, cursor:"0", changes_since:[]}'}
          </code>
        </section>
      </div>
    </main>
  )
}
