import { useMemo, useState } from 'react'
import { describeEvent, eventTargetsNode, getDisplayState } from '../model/graph'
import type { GraphEdge, MissionEvent, TaskNode } from '../model/types'
import { useMissionStore } from '../store/mission-store'
import { previewNativeSplit } from '../webmcp/tools'

const tabs = ['Brief', 'Handoff', 'Deviations', 'Decisions', 'Log'] as const
type Tab = (typeof tabs)[number]

interface InspectorProps {
  nodes: TaskNode[]
  edges: GraphEdge[]
  events: MissionEvent[]
}

function EmptyRecord({ children }: { children: string }) {
  return <p className="inspector-empty">{children}</p>
}

function ProseRecord({ children }: { children: React.ReactNode }) {
  return <article className="prose-record">{children}</article>
}

export function Inspector({ nodes, edges, events }: InspectorProps) {
  const selectedId = useMissionStore((state) => state.selectedId)
  const approve = useMissionStore((state) => state.approve)
  const reject = useMissionStore((state) => state.reject)
  const dispatch = useMissionStore((state) => state.dispatch)
  const setNodeRunState = useMissionStore((state) => state.setNodeRunState)
  const select = useMissionStore((state) => state.select)
  const showToast = useMissionStore((state) => state.showToast)
  const approvals = useMissionStore((state) => state.approvals)
  const annotations = useMissionStore((state) => state.annotations)
  const handoffs = useMissionStore((state) => state.handoffs)
  const storedDeviations = useMissionStore((state) => state.deviations)
  const workerLogs = useMissionStore((state) => state.workerLogs)
  const [activeTab, setActiveTab] = useState<Tab>('Brief')
  const [splitDraft, setSplitDraft] = useState<{
    nodeId: string
    first: string
    second: string
  } | null>(null)
  const node = nodes.find((candidate) => candidate.id === selectedId)
  const edge = edges.find((candidate) => candidate.edge_id === selectedId)
  const activeSplitDraft = splitDraft?.nodeId === node?.id ? splitDraft : null
  const firstChildTitle = activeSplitDraft?.first ?? ''
  const secondChildTitle = activeSplitDraft?.second ?? ''

  const relevantEvents = useMemo(
    () =>
      events.filter((event) => {
        if (node) {
          return eventTargetsNode(event, node.id)
        }
        if (edge) {
          return (
            (event.type === 'EDGE_ADDED' &&
              event.payload.edge_id === edge.edge_id) ||
            (event.type === 'EDGE_REMOVED' &&
              event.payload.edge_id === edge.edge_id) ||
            (event.type === 'ANNOTATED' &&
              event.payload.target_id === edge.edge_id)
          )
        }
        return false
      }),
    [edge, events, node],
  )

  if (!node && !edge) {
    return (
      <aside className="inspector-panel">
        <div className="inspector-blank">
          <div className="inspector-orbit" aria-hidden="true" />
          <p className="text-xs font-semibold tracking-[0.12em] text-slate-500 uppercase">
            Dossier ready
          </p>
          <h2 className="mt-3 text-xl font-medium text-slate-200">
            Select work to inspect
          </h2>
          <p className="mt-2 max-w-60 text-sm leading-6 text-slate-500">
            Choose a task or relationship to read its brief, handoff, decisions,
            and worker record.
          </p>
        </div>
      </aside>
    )
  }

  const upstream = edge
    ? nodes.find((candidate) => candidate.id === edge.upstream)
    : undefined
  const downstream = edge
    ? nodes.find((candidate) => candidate.id === edge.downstream)
    : undefined
  const decisions = relevantEvents.filter((event) =>
    ['APPROVAL_CREATED', 'APPROVED', 'REJECTED', 'ANNOTATED'].includes(event.type),
  )
  const approval = node
    ? Object.values(approvals).find(
        (item) => item.node_id === node.id && item.status === 'pending',
      )
    : undefined
  const displayState = node ? getDisplayState(node, nodes, edges) : undefined
  const splitOrigin = node
    ? events.find(
        (event): event is Extract<MissionEvent, { type: 'TASK_SPLIT' }> =>
          event.type === 'TASK_SPLIT' &&
          event.payload.children.some((child) => child.id === node.id),
      )
    : undefined
  const splitParent = splitOrigin
    ? nodes.find((candidate) => candidate.id === splitOrigin.payload.parent_id)
    : undefined
  const runtimeNode = node as
    | (TaskNode & {
        record_type?: 'task' | 'group'
        child_ids?: string[]
        pause_requested?: boolean
      })
    | undefined

  function previewSplit() {
    if (!node) return
    const estimate = Math.max(1, Math.round(node.estimate_min / 2))
    void previewNativeSplit(node.id, [
      {
        temp_id: 'first',
        title: firstChildTitle,
        brief: `Deliver the first bounded part of “${node.title}”: ${firstChildTitle}.`,
        estimate,
        tags: node.tags,
        deps: [],
      },
      {
        temp_id: 'second',
        title: secondChildTitle,
        brief: `Complete “${node.title}” by integrating ${secondChildTitle}.`,
        estimate,
        tags: node.tags,
        deps: ['first'],
      },
    ]).catch((error: unknown) =>
      showToast(error instanceof Error ? error.message : String(error), 'error'),
    )
  }

  return (
    <aside className="inspector-panel">
      <div className="inspector-heading">
        <div className="flex items-center gap-2 text-[10px] tracking-[0.14em] text-slate-500 uppercase">
          <span className="h-px w-5 bg-slate-700" />
          {node ? 'Task dossier' : 'Relationship dossier'}
        </div>
        <h2 className="mt-3 text-xl leading-7 font-semibold tracking-[-0.02em] text-slate-100">
          {node?.title ?? `${upstream?.title} ↔ ${downstream?.title}`}
        </h2>
        <div className="mt-3 flex items-center gap-2">
          {displayState && (
            <span className={`inspector-status inspector-status--${displayState}`}>
              {displayState}
            </span>
          )}
          {approval && (
            <span
              className={
                approval.diff_stats?.files.some((file) => file.includes('schema'))
                  ? 'inspector-risk inspector-risk--schema'
                  : 'inspector-risk'
              }
            >
              {approval.diff_stats?.files.some((file) => file.includes('schema'))
                ? 'Schema exception'
                : 'Pending review'}
            </span>
          )}
          {edge && (
            <span className="inspector-risk">
              {edge.kind === 'depends' ? 'Required dependency' : 'Advisory conflict'}
            </span>
          )}
        </div>
      </div>

      <nav className="inspector-tabs" aria-label="Dossier sections">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={activeTab === tab ? 'is-active' : ''}
          >
            {tab}
          </button>
        ))}
      </nav>

      <div className="inspector-body">
        {activeTab === 'Brief' && node && (
          <>
            <p className="inspector-kicker">What this work changes</p>
            <p className="inspector-prose">{node.brief}</p>
            <div className="inspector-facts">
              <div>
                <span>Expected effort</span>
                <strong>{node.estimate_min} minutes</strong>
              </div>
              <div>
                <span>Work areas</span>
                <strong>{node.tags.join(' · ')}</strong>
              </div>
            </div>
            {(annotations[node.id] ?? []).map((annotation) => (
              <ProseRecord key={`${annotation.ts}-${annotation.note}`}>
                {annotation.note}
              </ProseRecord>
            ))}
            {splitParent && (
              <ProseRecord>
                <p>
                  This child was created when “{splitParent.title}” was split. Its
                  parent keeps the partial handoff and earlier decision history.
                </p>
                <button
                  type="button"
                  className="inspector-history-link"
                  onClick={() => select(splitParent.id)}
                >
                  Open parent history
                </button>
              </ProseRecord>
            )}
            {runtimeNode?.record_type === 'group' && (
              <ProseRecord>
                This retired parent remains as the historical record for{' '}
                {(runtimeNode.child_ids ?? [])
                  .map(
                    (id) => nodes.find((candidate) => candidate.id === id)?.title ?? id,
                  )
                  .join(', ')}.
              </ProseRecord>
            )}
          </>
        )}
        {activeTab === 'Brief' && edge && (
          <>
            <p className="inspector-kicker">Why this relationship matters</p>
            <p className="inspector-prose">
              {edge.kind === 'depends'
                ? `${downstream?.title} cannot finish its intended work until ${upstream?.title} has delivered the prerequisite.`
                : `${upstream?.title} and ${downstream?.title} touch overlapping implementation areas. They may proceed in parallel, but their workers should coordinate before handoff.`}
            </p>
            {(annotations[edge.edge_id] ?? []).map((annotation) => (
              <ProseRecord key={`${annotation.ts}-${annotation.note}`}>
                {annotation.note}
              </ProseRecord>
            ))}
          </>
        )}

        {activeTab === 'Handoff' &&
          (node && handoffs[node.id] ? (
            <>
              <p className="inspector-prose">{handoffs[node.id].summary}</p>
              <ProseRecord>
                <p>{handoffs[node.id].downstream_notes}</p>
                <p className="mt-3 text-xs text-slate-500">
                  Tests: {handoffs[node.id].tests} · Files:{' '}
                  {handoffs[node.id].files.join(', ')}
                </p>
              </ProseRecord>
            </>
          ) : (
            <EmptyRecord>
              No handoff has been filed yet. This dossier will preserve the worker’s
              delivered outcome in human-readable form.
            </EmptyRecord>
          ))}

        {activeTab === 'Deviations' &&
          (node && (storedDeviations[node.id]?.length ?? 0) > 0 ? (
            storedDeviations[node.id].map((deviation) => (
              <ProseRecord key={`${deviation.ts}-${deviation.text}`}>
                <p>{deviation.text}</p>
                {deviation.actual_min && (
                  <p className="mt-3 text-xs text-slate-500">
                    Planned {deviation.est_min} minutes; observed{' '}
                    {deviation.actual_min} minutes.
                  </p>
                )}
              </ProseRecord>
            ))
          ) : (
            <EmptyRecord>
              No meaningful drift from the brief has been recorded for this work.
            </EmptyRecord>
          ))}

        {activeTab === 'Decisions' &&
          (decisions.length > 0 ? (
            decisions.map((event) => (
              <ProseRecord key={event.idem_key}>
                {describeEvent(event, nodes, edges)}
              </ProseRecord>
            ))
          ) : (
            <EmptyRecord>
              No approval, rejection, or rationale has been recorded here yet.
            </EmptyRecord>
          ))}

        {activeTab === 'Log' &&
          (node && (workerLogs[node.id]?.length ?? 0) > 0 ? (
            workerLogs[node.id].map((line, index) => (
              <ProseRecord key={`${index}-${line}`}>{line}</ProseRecord>
            ))
          ) : (
            <EmptyRecord>
              No worker log has arrived for this selection. Logs are rendered as
              plain text when present.
            </EmptyRecord>
          ))}
      </div>

      {node && (
        <div className="inspector-actions">
          <button
            type="button"
            className="action-primary"
            disabled={node.state !== 'review' || runtimeNode?.record_type === 'group'}
            onClick={() => approve(node.id)}
          >
            Approve
          </button>
          <button
            type="button"
            className="action-secondary"
            disabled={node.state !== 'review' || runtimeNode?.record_type === 'group'}
            onClick={() => reject(node.id)}
          >
            Reject
          </button>
          <button
            type="button"
            className="action-secondary"
            disabled={displayState !== 'ready' || runtimeNode?.record_type === 'group'}
            onClick={() => dispatch(node.id)}
          >
            Dispatch
          </button>
          {node.state === 'running' && runtimeNode?.record_type !== 'group' && (
            <button
              type="button"
              className="action-secondary"
              disabled={runtimeNode?.pause_requested}
              onClick={() => setNodeRunState(node.id, 'pause')}
            >
              {runtimeNode?.pause_requested ? 'Pausing…' : 'Pause safely'}
            </button>
          )}
          {node.state === 'paused' && runtimeNode?.record_type !== 'group' && (
            <button
              type="button"
              className="action-secondary"
              onClick={() => setNodeRunState(node.id, 'resume')}
            >
              Resume
            </button>
          )}
          {runtimeNode?.record_type !== 'group' && (
            <button
              type="button"
              className="action-secondary"
              onClick={() =>
                setSplitDraft(
                  activeSplitDraft
                    ? null
                    : {
                        nodeId: node.id,
                        first: `${node.title} · foundation`,
                        second: `${node.title} · integration`,
                      },
                )
              }
            >
              Split task
            </button>
          )}
          {activeSplitDraft && runtimeNode?.record_type !== 'group' && (
            <div className="inspector-split-form">
              <p>Define two sequential child tasks. You will review the shared blast-radius dialog before anything changes.</p>
              <label>
                First child
                <input
                  value={firstChildTitle}
                  onChange={(event) =>
                    setSplitDraft({
                      ...activeSplitDraft,
                      first: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Second child
                <input
                  value={secondChildTitle}
                  onChange={(event) =>
                    setSplitDraft({
                      ...activeSplitDraft,
                      second: event.target.value,
                    })
                  }
                />
              </label>
              <button
                type="button"
                className="action-primary"
                disabled={!firstChildTitle.trim() || !secondChildTitle.trim()}
                onClick={previewSplit}
              >
                Preview split
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
