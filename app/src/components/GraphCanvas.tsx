import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
} from '@xyflow/react'
import ELK from 'elkjs/lib/elk.bundled.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '@xyflow/react/dist/style.css'
import {
  getCriticalPath,
  getDisplayState,
  getEventNodeId,
  type DisplayState,
} from '../model/graph'
import { useMissionStore } from '../store/mission-store'
import { resetMissionDemo } from '../transport/client'
import { Inspector } from './Inspector'
import { PulseBar } from './PulseBar'
import { TaskNodeCard, type TaskFlowNode } from './TaskNodeCard'
import { Timeline } from './Timeline'

const elk = new ELK()
const nodeTypes = { missionTask: TaskNodeCard }

async function createLayout(nodeIds: string[], edges: Edge[]) {
  const graph = await elk.layout({
    id: 'mission-root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '38',
      'elk.layered.spacing.nodeNodeBetweenLayers': '150',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children: nodeIds.map((id) => ({ id, width: 244, height: 142 })),
    edges: edges
      .filter((edge) => edge.data?.kind === 'depends')
      .map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
  })

  return Object.fromEntries(
    (graph.children ?? []).map((node) => [
      node.id,
      { x: node.x ?? 0, y: node.y ?? 0 },
    ]),
  )
}

function MissionBoard() {
  const nodes = useMissionStore((state) => state.nodes)
  const edges = useMissionStore((state) => state.edges)
  const events = useMissionStore((state) => state.events)
  const positions = useMissionStore((state) => state.positions)
  const selectedId = useMissionStore((state) => state.selectedId)
  const highlightedIds = useMissionStore((state) => state.highlightedIds)
  const readySince = useMissionStore((state) => state.readySince)
  const approvals = useMissionStore((state) => state.approvals)
  const cameraRequest = useMissionStore((state) => state.cameraRequest)
  const connectionMode = useMissionStore((state) => state.connectionMode)
  const connectionMessage = useMissionStore((state) => state.connectionMessage)
  const projectId = useMissionStore((state) => state.projectId)
  const toast = useMissionStore((state) => state.toast)
  const hydratePositions = useMissionStore((state) => state.hydratePositions)
  const moveNode = useMissionStore((state) => state.moveNode)
  const connectNodes = useMissionStore((state) => state.connectNodes)
  const removeSelected = useMissionStore((state) => state.removeSelected)
  const select = useMissionStore((state) => state.select)
  const setHighlights = useMissionStore((state) => state.setHighlights)
  const clearToast = useMissionStore((state) => state.clearToast)
  const [dragPositions, setDragPositions] = useState<
    Record<string, { x: number; y: number }>
  >({})
  const [nodeDims, setNodeDims] = useState<
    Record<string, { width: number; height: number }>
  >({})
  const [replaying, setReplaying] = useState(false)
  const hasLaidOut = useRef(false)
  const { fitView, setCenter } = useReactFlow<TaskFlowNode, Edge>()
  const criticalPath = useMemo(
    () => getCriticalPath(nodes, edges),
    [edges, nodes],
  )

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((edge) => {
        const critical = criticalPath.edgeIds.includes(edge.edge_id)
        const conflict = edge.kind === 'conflicts'
        return {
          id: edge.edge_id,
          source: edge.upstream,
          target: edge.downstream,
          selected: selectedId === edge.edge_id,
          data: { kind: edge.kind },
          type: conflict ? 'straight' : 'smoothstep',
          animated: critical,
          markerEnd: conflict
            ? undefined
            : {
                type: MarkerType.ArrowClosed,
                color: critical ? '#f4c76f' : '#53657a',
                width: 15,
                height: 15,
              },
          style: conflict
            ? {
                stroke: '#8c789c',
                strokeWidth: selectedId === edge.edge_id ? 2 : 1.2,
                strokeDasharray: '6 7',
                opacity: selectedId === edge.edge_id ? 0.95 : 0.42,
              }
            : {
                stroke: critical ? '#f4c76f' : '#53657a',
                strokeWidth: critical ? 4 : selectedId === edge.edge_id ? 3 : 1.6,
                opacity: critical ? 0.95 : 0.68,
              },
          className: critical ? 'critical-flow-edge' : undefined,
        }
      }),
    [criticalPath.edgeIds, edges, selectedId],
  )

  const flowNodes: TaskFlowNode[] = useMemo(
    () =>
      nodes.map((node, index) => {
        const displayState = getDisplayState(node, nodes, edges)
        return {
          id: node.id,
          type: 'missionTask',
          position:
            dragPositions[node.id] ??
            positions[node.id] ?? { x: (index % 3) * 320, y: Math.floor(index / 3) * 190 },
          selected: selectedId === node.id,
          ...(nodeDims[node.id] ? { measured: nodeDims[node.id] } : {}),
          data: {
            title: node.title,
            brief: node.brief,
            estimate: node.estimate_min,
            tags: node.tags,
            displayState,
            approval:
              node.state === 'review' &&
              Object.values(approvals).some(
                (approval) =>
                  approval.node_id === node.id && approval.status === 'pending',
              ),
            idleFor: displayState === 'ready' ? readySince[node.id] : undefined,
            critical: criticalPath.nodeIds.includes(node.id),
            highlighted: highlightedIds.includes(node.id),
          },
        }
      }),
    [
      criticalPath.nodeIds,
      approvals,
      dragPositions,
      edges,
      highlightedIds,
      nodeDims,
      nodes,
      positions,
      readySince,
      selectedId,
    ],
  )

  useEffect(() => {
    hasLaidOut.current = false
  }, [projectId])

  useEffect(() => {
    if (
      connectionMode === 'loading' ||
      hasLaidOut.current ||
      nodes.length === 0
    ) {
      return
    }
    hasLaidOut.current = true
    void createLayout(
      nodes.map((node) => node.id),
      flowEdges,
    ).then((layout) => {
      hydratePositions(layout)
      window.setTimeout(() => void fitView({ padding: 0.16, duration: 280 }), 0)
    })
  }, [connectionMode, fitView, flowEdges, hydratePositions, nodes])

  useEffect(() => {
    if (!cameraRequest) return
    const focused = flowNodes.filter((node) =>
      cameraRequest.nodeIds.includes(node.id),
    )
    if (focused.length > 0) {
      void fitView({ nodes: focused, padding: 0.28, duration: 420 })
    }
  }, [cameraRequest, fitView, flowNodes])

  useEffect(() => {
    function handleDelete(event: KeyboardEvent) {
      if (
        event.key !== 'Delete' &&
        event.key !== 'Backspace'
      ) {
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, [contenteditable="true"]')) {
        return
      }
      event.preventDefault()
      removeSelected()
    }
    window.addEventListener('keydown', handleDelete)
    return () => window.removeEventListener('keydown', handleDelete)
  }, [removeSelected])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(clearToast, 3200)
    return () => window.clearTimeout(timeout)
  }, [clearToast, toast])

  const onNodesChange = useCallback((changes: NodeChange<TaskFlowNode>[]) => {
    setNodeDims((current) => {
      let next = current
      for (const change of changes) {
        if (change.type === 'dimensions' && change.dimensions) {
          if (next === current) next = { ...current }
          next[change.id] = change.dimensions
        }
      }
      return next
    })
    setDragPositions((current) => {
      const next = { ...current }
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          next[change.id] = change.position
        }
      }
      return next
    })
  }, [])

  function onConnect(connection: Connection) {
    if (connection.source && connection.target) {
      connectNodes(connection.source, connection.target)
    }
  }

  const jumpToNode = useCallback(
    (nodeId: string) => {
      const point = positions[nodeId]
      if (!point) return
      select(nodeId)
      void setCenter(point.x + 122, point.y + 71, {
        zoom: 1.05,
        duration: 260,
      })
    },
    [positions, select, setCenter],
  )

  async function replayCatchUp() {
    if (replaying) return
    setReplaying(true)
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches
    const recentNodeIds = events
      .filter((event) => !['NODE_MOVED', 'SELECTION_CHANGED'].includes(event.type))
      .slice(-12)
      .map((event) => getEventNodeId(event, edges))
      .filter((id): id is string => Boolean(id))
      .filter((id, index, all) => all.indexOf(id) === index)
      .slice(-6)

    for (const nodeId of recentNodeIds) {
      setHighlights([nodeId])
      const point = positions[nodeId]
      if (point) {
        void setCenter(point.x + 122, point.y + 71, {
          zoom: 0.95,
          duration: reducedMotion ? 0 : 240,
        })
      }
      if (!reducedMotion) {
        await new Promise((resolve) => window.setTimeout(resolve, 310))
      }
    }
    setHighlights([])
    setReplaying(false)
  }

  const counts = useMemo(() => {
    const base: Record<DisplayState, number> = {
      queued: 0,
      ready: 0,
      running: 0,
      review: 0,
      done: 0,
      failed: 0,
      paused: 0,
      blocked: 0,
    }
    for (const node of nodes) {
      base[getDisplayState(node, nodes, edges)]++
    }
    return base
  }, [edges, nodes])

  return (
    <main className="mission-shell">
      <PulseBar
        eta={criticalPath.eta}
        counts={counts}
        onCatchUp={() => void replayCatchUp()}
        onReset={() => void resetMissionDemo()}
        replaying={replaying}
        connectionMode={connectionMode}
        connectionMessage={connectionMessage}
      />
      <div className="canvas-stage">
        <ReactFlow<TaskFlowNode, Edge>
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={(_, node) => {
            moveNode(node.id, node.position)
            setDragPositions((current) => {
              const next = { ...current }
              delete next[node.id]
              return next
            })
          }}
          onConnect={onConnect}
          onNodeClick={(_, node) => select(node.id)}
          onEdgeClick={(_, edge) => select(edge.id)}
          onPaneClick={() => select(null)}
          deleteKeyCode={null}
          minZoom={0.25}
          maxZoom={1.7}
          defaultEdgeOptions={{ zIndex: 1 }}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1}
            color="#233041"
          />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
        <div className="canvas-legend">
          <span><i className="legend-line legend-line--critical" />Critical path</span>
          <span><i className="legend-line legend-line--conflict" />File conflict</span>
          <span className="hidden xl:inline">Drag to arrange · connect ports to depend · delete to tombstone</span>
        </div>
      </div>
      <Inspector nodes={nodes} edges={edges} events={events} />
      <Timeline
        events={events}
        nodes={nodes}
        edges={edges}
        onJump={jumpToNode}
      />
      {toast && (
        <div className={`mission-toast mission-toast--${toast.tone}`} role="status">
          {toast.message}
        </div>
      )}
    </main>
  )
}

export function GraphCanvas() {
  return (
    <ReactFlowProvider>
      <MissionBoard />
    </ReactFlowProvider>
  )
}
