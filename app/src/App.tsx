import { useEffect } from 'react'
import { GraphCanvas } from './components/GraphCanvas'
import { CompatPage } from './pages/CompatPage'
import { initializeWebMcp } from './webmcp/registry'

function App() {
  useEffect(() => {
    void initializeWebMcp()
  }, [])

  return window.location.pathname === '/compat' ? <CompatPage /> : <GraphCanvas />
}

export default App
