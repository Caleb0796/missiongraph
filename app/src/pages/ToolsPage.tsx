import { useMemo, useState } from 'react'
import { GraphCanvas } from '../components/GraphCanvas'
import { useMissionStore } from '../store/mission-store'
import {
  executeRegisteredTool,
  executeToolDirect,
  getWebMcpRuntime,
  initializeWebMcp,
} from '../webmcp/registry'
import {
  contextualMissionTools,
  contextualToolsForCurrentState,
  missionTools,
} from '../webmcp/tools'

function prettyResult(value: string | null) {
  if (value === null) return 'Tool returned null.'
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

export function ToolsPage() {
  const [selected, setSelected] = useState(
    () =>
      new URLSearchParams(window.location.search).get('tool') ??
      missionTools[0]?.name ??
      '',
  )
  const [input, setInput] = useState('{\n  \n}')
  const [output, setOutput] = useState('Choose a tool and execute it.')
  const [inlineError, setInlineError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const connectionMode = useMissionStore((state) => state.connectionMode)
  const definition = useMemo(
    () => missionTools.find((tool) => tool.name === selected),
    [selected],
  )

  async function execute() {
    setRunning(true)
    setInlineError(null)
    try {
      if (!definition) {
        throw new Error(
          `Tool “${selected || 'unknown'}” is no longer available. Choose a registered tool.`,
        )
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(input) as unknown
      } catch {
        throw new Error('Input is not valid JSON. Check commas, quotes, and braces.')
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Tool input must be a JSON object.')
      }
      await initializeWebMcp(missionTools, {
        all: contextualMissionTools,
        current: contextualToolsForCurrentState,
      })
      const runtime = getWebMcpRuntime()
      if (runtime) {
        const tools = await runtime.modelContext.getTools()
        const tool = tools.find((candidate) => candidate.name === selected)
        if (!tool) throw new Error(`${selected} is not visible in getTools().`)
        setOutput(
          prettyResult(
            await executeRegisteredTool(
              runtime,
              tool,
              parsed as Record<string, unknown>,
            ),
          ),
        )
      } else {
        setOutput(
          prettyResult(
            await executeToolDirect(
              selected,
              parsed as Record<string, unknown>,
            ),
          ),
        )
      }
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <GraphCanvas />
      <aside className="tool-console" aria-label="WebMCP Tool Console">
        <header className="tool-console-heading">
          <div>
            <p>Development surface</p>
            <h1>Tool Console</h1>
          </div>
          <a href="/">Close</a>
        </header>
        <div className="tool-console-status">
          {missionTools.length} M5 core tools · {connectionMode}
        </div>
        <label className="tool-console-label" htmlFor="tool-name">
          Registered tool
        </label>
        <select
          id="tool-name"
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value)
            setInput('{\n  \n}')
            setInlineError(null)
          }}
        >
          {!definition && selected && (
            <option value={selected}>{selected} (unavailable)</option>
          )}
          {missionTools.map((tool) => (
            <option key={tool.name} value={tool.name}>
              {tool.name}
            </option>
          ))}
        </select>
        <p className="tool-console-description">
          {definition?.description ?? 'This tool is unknown or was removed.'}
        </p>
        {definition && (
          <details className="tool-console-schema">
            <summary>JSON schema</summary>
            <pre>{JSON.stringify(definition.inputSchema, null, 2)}</pre>
          </details>
        )}
        <label className="tool-console-label" htmlFor="tool-input">
          JSON input
        </label>
        <textarea
          id="tool-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          spellCheck={false}
        />
        <button type="button" onClick={() => void execute()} disabled={running}>
          {running ? 'Executing…' : 'Execute tool'}
        </button>
        {inlineError && (
          <p className="tool-console-error" role="alert">
            {inlineError}
          </p>
        )}
        <label className="tool-console-label">Result envelope</label>
        <pre className="tool-console-output">{output}</pre>
      </aside>
    </>
  )
}
