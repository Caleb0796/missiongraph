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
  humanizeIdleAge,
  idleRadar,
  isSplitParent,
  type DisplayState,
} from '../model/graph'
import { useMissionStore } from '../store/mission-store'
import {
  copyCurrentMissionLink,
  openStoredMission,
  reconnectMission,
  resetMissionDemo,
  startFreshMissionCopy,
} from '../transport/client'
import { skewCorrectedNow } from '../transport/client-logic'
import { FlightPanel } from './FlightPanel'
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
  const explainOverlays = useMissionStore((state) => state.explainOverlays)
  const readySince = useMissionStore((state) => state.readySince)
  const approvals = useMissionStore((state) => state.approvals)
  const cameraRequest = useMissionStore((state) => state.cameraRequest)
  const connectionMode = useMissionStore((state) => state.connectionMode)
  const connectionMessage = useMissionStore((state) => state.connectionMessage)
  const clockSkewMs = useMissionStore((state) => state.clockSkewMs)
  const linkErrorHasStoredIdentity = useMissionStore(
    (state) => state.linkErrorHasStoredIdentity,
  )
  const projectId = useMissionStore((state) => state.projectId)
  const topologyRevision = useMissionStore((state) => state.topologyRevision)
  const toast = useMissionStore((state) => state.toast)
  const structuralPreview = useMissionStore((state) => state.structuralPreview)
  const contextualToolsDegraded = useMissionStore(
    (state) => state.contextualToolsDegraded,
  )
  const hydratePositions = useMissionStore((state) => state.hydratePositions)
  const relayoutPositions = useMissionStore((state) => state.relayoutPositions)
  const moveNode = useMissionStore((state) => state.moveNode)
  const connectNodes = useMissionStore((state) => state.connectNodes)
  const removeSelected = useMissionStore((state) => state.removeSelected)
  const select = useMissionStore((state) => state.select)
  const setHighlights = useMissionStore((state) => state.setHighlights)
  const clearToast = useMissionStore((state) => state.clearToast)
  const confirmStructural = useMissionStore((state) => state.confirmStructural)
  const cancelStructural = useMissionStore((state) => state.cancelStructural)
  const [dragPositions, setDragPositions] = useState<
    Record<string, { x: number; y: number }>
  >({})
  const [nodeDims, setNodeDims] = useState<
    Record<string, { width: number; height: number }>
  >({})
  const [replaying, setReplaying] = useState(false)
  const [relayouting, setRelayouting] = useState(false)
  const [layoutRetry, setLayoutRetry] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const hasLaidOut = useRef(false)
  const layoutRequest = useRef<{
    projectId: string | null
    revision: number
    signature: string
  } | null>(null)
  const relayoutTimer = useRef<number | null>(null)
  const layoutDebounce = useRef<number | null>(null)
  const { fitView, setCenter } = useReactFlow<TaskFlowNode, Edge>()
  const criticalPath = useMemo(
    () => getCriticalPath(nodes, edges),
    [edges, nodes],
  )
  const correctedNow = skewCorrectedNow(now, clockSkewMs)
  const idleNodeIds = useMemo(
    () =>
      new Set(
        idleRadar(nodes, edges, readySince, correctedNow).map((node) => node.id),
      ),
    [correctedNow, edges, nodes, readySince],
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
          className: relayouting ? 'mission-flow-node--relayouting' : undefined,
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
            idleFor:
              idleNodeIds.has(node.id) && readySince[node.id]
                ? humanizeIdleAge(readySince[node.id], correctedNow)
                : undefined,
            critical: criticalPath.nodeIds.includes(node.id),
            highlighted: highlightedIds.includes(node.id),
            previewStale:
              structuralPreview?.blastRadius.stale.includes(node.id) ?? false,
            previewPausing:
              structuralPreview?.blastRadius.pausing.includes(node.id) ?? false,
            recordType:
              (node as typeof node & { record_type?: 'task' | 'group' })
                .record_type ?? 'task',
            pauseRequested:
              (node as typeof node & { pause_requested?: boolean })
                .pause_requested ?? false,
            overlayText: explainOverlays[node.id]?.text,
          },
        }
      }),
    [
      criticalPath.nodeIds,
      approvals,
      dragPositions,
      edges,
      explainOverlays,
      highlightedIds,
      idleNodeIds,
      nodeDims,
      nodes,
      positions,
      relayouting,
      readySince,
      selectedId,
      structuralPreview,
      correctedNow,
    ],
  )

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    hasLaidOut.current = false
    layoutRequest.current = null
    const resetRelayouting = window.setTimeout(() => setRelayouting(false), 0)
    if (relayoutTimer.current !== null) {
      window.clearTimeout(relayoutTimer.current)
      relayoutTimer.current = null
    }
    if (layoutDebounce.current !== null) {
      window.clearTimeout(layoutDebounce.current)
      layoutDebounce.current = null
    }
    return () => window.clearTimeout(resetRelayouting)
  }, [projectId])

  useEffect(() => {
    if (connectionMode === 'loading' || nodes.length === 0) {
      return
    }
    const signature = `${nodes.map((node) => node.id).sort().join(',')}|${edges
      .map((edge) => `${edge.edge_id}:${edge.upstream}:${edge.downstream}`)
      .sort()
      .join(',')}`
    const firstLayout = !hasLaidOut.current
    if (
      !firstLayout &&
      layoutRequest.current?.projectId === projectId &&
      layoutRequest.current.revision === topologyRevision &&
      layoutRequest.current.signature === signature
    ) {
      return
    }
    hasLaidOut.current = true
    const scheduledRevision = topologyRevision
    const scheduledProjectId = projectId
    layoutRequest.current = {
      projectId: scheduledProjectId,
      revision: scheduledRevision,
      signature,
    }
    const isCurrentLayout = () =>
      useMissionStore.getState().topologyRevision === scheduledRevision &&
      useMissionStore.getState().projectId === scheduledProjectId
    const layout = () => {
      if (!firstLayout) setRelayouting(true)
      void createLayout(
        nodes.map((node) => node.id),
        flowEdges,
      ).then((positions) => {
        if (!isCurrentLayout()) {
          if (
            layoutRequest.current?.projectId === scheduledProjectId &&
            layoutRequest.current.revision === scheduledRevision
          ) {
            layoutRequest.current = null
            setLayoutRetry((current) => current + 1)
          }
          return
        }
        if (firstLayout) hydratePositions(positions)
        else relayoutPositions(positions)
        window.setTimeout(() => {
          if (isCurrentLayout()) {
            void fitView({
              padding: 0.16,
              duration: firstLayout ? 280 : 520,
            })
          }
        }, 0)
        if (relayoutTimer.current !== null) {
          window.clearTimeout(relayoutTimer.current)
        }
        relayoutTimer.current = window.setTimeout(() => {
          if (!isCurrentLayout()) return
          setRelayouting(false)
          relayoutTimer.current = null
        }, 560)
      })
    }
    if (firstLayout) layout()
    else {
      if (layoutDebounce.current !== null) {
        window.clearTimeout(layoutDebounce.current)
      }
      layoutDebounce.current = window.setTimeout(() => {
        layoutDebounce.current = null
        layout()
      }, 80)
    }
  }, [
    connectionMode,
    edges,
    fitView,
    flowEdges,
    hydratePositions,
    layoutRetry,
    nodes,
    projectId,
    relayoutPositions,
    topologyRevision,
  ])

  useEffect(
    () => () => {
      if (relayoutTimer.current !== null) window.clearTimeout(relayoutTimer.current)
      if (layoutDebounce.current !== null) window.clearTimeout(layoutDebounce.current)
    },
    [],
  )

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

  async function copyMissionLink() {
    try {
      const result = await copyCurrentMissionLink()
      useMissionStore
        .getState()
        .showToast(
          result.copied ? 'Mission link copied' : 'Copy this mission link manually',
          'info',
          result.copied
            ? 'anyone with this link can act on this mission'
            : result.url,
        )
    } catch (error) {
      useMissionStore
        .getState()
        .showToast(error instanceof Error ? error.message : String(error), 'error')
    }
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
      if (isSplitParent(node)) continue
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
        onCopyMissionLink={() => void copyMissionLink()}
        onReconnect={() => void reconnectMission()}
        onStartFreshMission={() => void startFreshMissionCopy()}
        onOpenStoredMission={() => void openStoredMission()}
        replaying={replaying}
        connectionMode={connectionMode}
        connectionMessage={connectionMessage}
        linkErrorHasStoredIdentity={linkErrorHasStoredIdentity}
        contextualToolsDegraded={contextualToolsDegraded}
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
        <FlightPanel now={correctedNow} />
        {structuralPreview && (
          <section className="structural-confirm" role="dialog" aria-modal="true">
            <p className="structural-confirm-kicker">Blast-radius preview</p>
            <h2>{structuralPreview.title}</h2>
            {structuralPreview.notice && <p>{structuralPreview.notice}.</p>}
            {structuralPreview.proposal && (
              <div className="structural-confirm-plan">
                <p>
                  Children:{' '}
                  {structuralPreview.proposal.children
                    .map((child) => child.title)
                    .join(', ')}.
                </p>
                {structuralPreview.proposal.edgeRemap.length > 0 ? (
                  <ul>
                    {structuralPreview.proposal.edgeRemap.map((remap) => (
                      <li key={remap.edgeId}>
                        {remap.kind === 'depends' ? 'Dependency' : 'Conflict'}{' '}
                        {remap.edgeId} reattaches as{' '}
                        {remap.upstreamTitle}{' '}
                        {remap.kind === 'depends' ? '→' : '↔'}{' '}
                        {remap.downstreamTitle}.
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No existing relationships need reattachment.</p>
                )}
              </div>
            )}
            {structuralPreview.blastRadius.stale.length > 0 ? (
              <p>
                Context may become stale for{' '}
                {structuralPreview.blastRadius.stale
                  .map(
                    (id) =>
                      nodes.find((node) => node.id === id)?.title ?? 'removed work',
                  )
                  .join(', ')}.
              </p>
            ) : (
              <p>No already-briefed downstream work will become stale.</p>
            )}
            <p className="structural-confirm-token">
              Preview bound at cursor {structuralPreview.baseCursor} · token{' '}
              {structuralPreview.opToken.slice(0, 8)}…
            </p>
            {structuralPreview.blastRadius.pausing.length > 0 && (
              <p>
                Running workers that may pause:{' '}
                {structuralPreview.blastRadius.pausing
                  .map(
                    (id) => nodes.find((node) => node.id === id)?.title ?? id,
                  )
                  .join(', ')}.
              </p>
            )}
            <div>
              <button type="button" className="action-secondary" onClick={cancelStructural}>
                Cancel
              </button>
              <button type="button" className="action-primary" onClick={confirmStructural}>
                Confirm change
              </button>
            </div>
          </section>
        )}
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
          <strong>{toast.message}</strong>
          {toast.caption && <span>{toast.caption}</span>}
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
