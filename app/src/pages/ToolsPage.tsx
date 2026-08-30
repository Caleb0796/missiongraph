import { useMemo, useState } from 'react'
import { GraphCanvas } from '../components/GraphCanvas'
import { useMissionStore } from '../store/mission-store'
import {
  executeToolDirect,
  getWebMcpRuntime,
  initializeWebMcp,
} from '../webmcp/registry'
import { m2Tools } from '../webmcp/tools'

function prettyResult(value: string | null) {
  if (value === null) return 'Tool returned null.'
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

export function ToolsPage() {
  const [selected, setSelected] = useState(m2Tools[0].name)
  const [input, setInput] = useState('{\n  \n}')
  const [output, setOutput] = useState('Choose a tool and execute it.')
  const [running, setRunning] = useState(false)
  const connectionMode = useMissionStore((state) => state.connectionMode)
  const definition = useMemo(
    () => m2Tools.find((tool) => tool.name === selected)!,
    [selected],
  )

  async function execute() {
    setRunning(true)
    try {
      const parsed = JSON.parse(input) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Tool input must be a JSON object.')
      }
      await initializeWebMcp(m2Tools)
      const runtime = getWebMcpRuntime()
      if (runtime) {
        const tools = await runtime.modelContext.getTools()
        const tool = tools.find((candidate) => candidate.name === selected)
        if (!tool) throw new Error(`${selected} is not visible in getTools().`)
        setOutput(
          prettyResult(
            await runtime.modelContext.executeTool(tool, JSON.stringify(parsed)),
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
      setOutput(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
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
          {m2Tools.length} M2 tools · {connectionMode}
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
          }}
        >
          {m2Tools.map((tool) => (
            <option key={tool.name} value={tool.name}>
              {tool.name}
            </option>
          ))}
        </select>
        <p className="tool-console-description">{definition.description}</p>
        <details className="tool-console-schema">
          <summary>JSON schema</summary>
          <pre>{JSON.stringify(definition.inputSchema, null, 2)}</pre>
        </details>
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
        <label className="tool-console-label">Result envelope</label>
        <pre className="tool-console-output">{output}</pre>
      </aside>
    </>
  )
}
