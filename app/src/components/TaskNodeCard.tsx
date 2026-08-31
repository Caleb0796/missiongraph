import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { DisplayState } from '../model/graph'

export interface TaskNodeData extends Record<string, unknown> {
  title: string
  brief: string
  estimate: number
  tags: string[]
  displayState: DisplayState
  approval: boolean
  idleFor?: string
  critical: boolean
  highlighted: boolean
  previewStale: boolean
  previewPausing: boolean
  recordType: 'task' | 'group'
  pauseRequested: boolean
  overlayText?: string
}

export type TaskFlowNode = Node<TaskNodeData, 'missionTask'>

const stateLabels: Record<DisplayState, string> = {
  queued: 'Queued',
  ready: 'Ready',
  running: 'Running',
  review: 'In review',
  done: 'Done',
  failed: 'Failed',
  paused: 'Paused',
  blocked: 'Blocked',
}

export function TaskNodeCard({ data, selected }: NodeProps<TaskFlowNode>) {
  return (
    <div
      className={`mission-node mission-node--${data.displayState} ${
        data.critical ? 'mission-node--critical' : ''
      } ${selected ? 'mission-node--selected' : ''} ${
        data.highlighted ? 'mission-node--highlighted' : ''
      } ${data.previewStale ? 'mission-node--preview-stale' : ''} ${
        data.previewPausing ? 'mission-node--preview-pausing' : ''
      } ${data.recordType === 'group' ? 'mission-node--split-parent' : ''}`}
    >
      {data.overlayText && (
        <aside className="mission-node-overlay" role="note">
          {data.overlayText}
        </aside>
      )}
      <Handle
        type="target"
        position={Position.Left}
        className="mission-handle"
      />
      <div className="flex items-center justify-between gap-3">
        <span className="mission-state">
          <span className="mission-state-dot" />
          {data.recordType === 'group'
            ? 'Split parent'
            : data.pauseRequested
              ? 'Pausing…'
              : stateLabels[data.displayState]}
        </span>
        <span className="font-mono text-[10px] tracking-[0.08em] text-slate-500">
          {data.estimate} min
        </span>
      </div>

      <h3 className="mt-3 text-[15px] leading-5 font-semibold tracking-[-0.01em] text-slate-100">
        {data.title}
      </h3>
      <p className="mt-1.5 line-clamp-2 text-[11px] leading-[1.55] text-slate-400">
        {data.brief}
      </p>

      <div className="mt-4 flex min-h-5 flex-wrap items-center gap-1.5">
        {data.tags.slice(0, 2).map((tag) => (
          <span key={tag} className="mission-tag">
            {tag}
          </span>
        ))}
        {data.approval && <span className="mission-approval">Approval</span>}
        {data.idleFor && <span className="mission-idle">{data.idleFor}</span>}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="mission-handle"
      />
    </div>
  )
}
