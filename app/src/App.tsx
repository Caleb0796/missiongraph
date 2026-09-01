import { useEffect } from 'react'
import { GraphCanvas } from './components/GraphCanvas'
import { CompatPage } from './pages/CompatPage'
import { ToolsPage } from './pages/ToolsPage'
import {
  initializeMissionClient,
  mountLiveFleet,
  unmountLiveFleet,
} from './transport/client'
import { initializeWebMcp } from './webmcp/registry'
import {
  contextualMissionTools,
  contextualToolsForCurrentState,
  missionTools,
} from './webmcp/tools'

function App() {
  useEffect(() => {
    if (window.location.pathname !== '/compat') {
      mountLiveFleet()
      const missionClientInitialization = initializeMissionClient()
      void initializeWebMcp(
        missionTools,
        {
          all: contextualMissionTools,
          current: contextualToolsForCurrentState,
        },
        { executionReady: missionClientInitialization },
      ).catch((error) => {
        console.error('[MissionGraph] WebMCP initialization failed.', error)
      })
      return unmountLiveFleet
    }
  }, [])

  if (window.location.pathname === '/compat') return <CompatPage />
  if (window.location.pathname === '/tools' && import.meta.env.DEV) {
    return <ToolsPage />
  }
  return <GraphCanvas />
}

export default App
