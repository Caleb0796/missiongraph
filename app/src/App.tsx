import { useEffect } from 'react'
import { GraphCanvas } from './components/GraphCanvas'
import { CompatPage } from './pages/CompatPage'
import { ToolsPage } from './pages/ToolsPage'
import { initializeMissionClient } from './transport/client'
import { initializeWebMcp } from './webmcp/registry'
import { missionTools } from './webmcp/tools'

function App() {
  useEffect(() => {
    if (window.location.pathname !== '/compat') {
      void initializeMissionClient().then(() => initializeWebMcp(missionTools))
    }
  }, [])

  if (window.location.pathname === '/compat') return <CompatPage />
  if (window.location.pathname === '/tools' && import.meta.env.DEV) {
    return <ToolsPage />
  }
  return <GraphCanvas />
}

export default App
