import { describeEvent, getEventNodeId } from '../model/graph'
import type { GraphEdge, MissionEvent, TaskNode } from '../model/types'

interface TimelineProps {
  events: MissionEvent[]
  nodes: TaskNode[]
  edges: GraphEdge[]
  onJump: (nodeId: string) => void
}

function actorLabel(actor: MissionEvent['actor']) {
  if (actor === 'human') return 'You'
  if (actor === 'browser_agent') return 'Your agent'
  if (actor === 'supervisor') return 'Supervisor'
  return 'Worker'
}

export function Timeline({ events, nodes, edges, onJump }: TimelineProps) {
  const visible = events
    .filter(
      (event) =>
        !['TASK_ADDED', 'EDGE_ADDED', 'NODE_MOVED', 'SELECTION_CHANGED'].includes(
          event.type,
        ),
    )
    .slice(-16)
    .reverse()

  return (
    <section className="timeline-strip" aria-label="Mission timeline">
      <div className="timeline-label">
        <span className="timeline-spark" />
        <div>
          <p>Timeline</p>
          <span>{visible.length} recent signals</span>
        </div>
      </div>
      <div className="timeline-events">
        {visible.map((event) => {
          const nodeId = getEventNodeId(event, edges)
          return (
            <button
              key={event.idem_key}
              type="button"
              className="timeline-event"
              disabled={!nodeId}
              onClick={() => nodeId && onJump(nodeId)}
              title={describeEvent(event, nodes, edges)}
            >
              <span className="timeline-event-meta">
                {actorLabel(event.actor)} ·{' '}
                {new Date(event.ts).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <span>{describeEvent(event, nodes, edges)}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
