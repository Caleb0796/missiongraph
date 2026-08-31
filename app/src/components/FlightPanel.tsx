import { useMemo, useState } from 'react'
import {
  approvalQueueFromRanking,
  humanizeIdleAge,
  idleRadar,
} from '../model/graph'
import { useMissionStore } from '../store/mission-store'

interface FlightPanelProps {
  now: number
}

export function FlightPanel({ now }: FlightPanelProps) {
  const nodes = useMissionStore((state) => state.nodes)
  const edges = useMissionStore((state) => state.edges)
  const approvals = useMissionStore((state) => state.approvals)
  const approvalRanking = useMissionStore((state) => state.approvalRanking)
  const approvalRankingSource = useMissionStore(
    (state) => state.approvalRankingSource,
  )
  const approvalRankingStale = useMissionStore(
    (state) => state.approvalRankingStale,
  )
  const policies = useMissionStore((state) => state.policies)
  const readySince = useMissionStore((state) => state.readySince)
  const sessionId = useMissionStore((state) => state.sessionId)
  const approve = useMissionStore((state) => state.approve)
  const reject = useMissionStore((state) => state.reject)
  const dispatch = useMissionStore((state) => state.dispatch)
  const [selectedPolicies, setSelectedPolicies] = useState<Record<string, string>>(
    {},
  )
  const ranked = useMemo(
    () => approvalQueueFromRanking(approvals, approvalRanking),
    [approvalRanking, approvals],
  )
  const idle = useMemo(
    () => idleRadar(nodes, edges, readySince, now),
    [edges, nodes, now, readySince],
  )
  const sessionPolicies = useMemo(
    () =>
      Object.entries(policies)
        .filter(([, policy]) => policy.session_id === sessionId)
        .sort((left, right) => left[1].stated_at.localeCompare(right[1].stated_at)),
    [policies, sessionId],
  )

  return (
    <aside className="flight-panel" aria-label="Flight supervision">
      <section>
        <header className="flight-panel-heading">
          <div>
            <p>
              {approvalRankingSource === 'server'
                ? `Server delay-ranked${approvalRankingStale ? ' · ranking may be stale' : ''}`
                : approvalRankingSource === 'fixture'
                  ? 'Fixture estimate-ranked'
                  : 'Waiting for server ranking'}
            </p>
            <h2>Approval queue</h2>
          </div>
          <span>{ranked.length}</span>
        </header>
        <div className="flight-list">
          {ranked.length === 0 && (
            <p className="flight-empty">No work is waiting for approval.</p>
          )}
          {ranked.map((approval) => {
            const target = nodes.find((node) => node.id === approval.node_id)
            const policyRef = selectedPolicies[approval.id] || undefined
            return (
              <article key={approval.id} className="approval-row">
                <div className="approval-row-title">
                  <strong>{target?.title ?? approval.node_id}</strong>
                  <span>{approval.delayImpactMin}m impact</span>
                </div>
                <p>{approval.summary}</p>
                <div className="approval-facts">
                  <span>
                    {approval.diff_stats
                      ? `+${approval.diff_stats.lines_added} −${approval.diff_stats.lines_removed} · ${approval.diff_stats.files.length} files`
                      : 'Diff stats unavailable'}
                  </span>
                  <span className={`tests-badge tests-badge--${approval.tests ?? 'none'}`}>
                    Tests {approval.tests ?? 'none'}
                  </span>
                </div>
                <label>
                  <span>Policy attribution</span>
                  <select
                    value={policyRef ?? ''}
                    onChange={(event) =>
                      setSelectedPolicies((current) => ({
                        ...current,
                        [approval.id]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Manual approval</option>
                    {sessionPolicies.map(([ref, policy]) => (
                      <option key={ref} value={ref}>
                        {policy.text}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="approval-row-actions">
                  <button type="button" onClick={() => reject(approval.node_id, policyRef)}>
                    Reject
                  </button>
                  <button type="button" onClick={() => approve(approval.node_id, policyRef)}>
                    Approve
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      </section>

      <section>
        <header className="flight-panel-heading">
          <div>
            <p>Ready · unassigned · 10m+</p>
            <h2>Idle radar</h2>
          </div>
          <span>{idle.length}</span>
        </header>
        <div className="flight-list">
          {idle.length === 0 && (
            <p className="flight-empty">No ready branch has crossed the idle threshold.</p>
          )}
          {idle.map((node) => (
            <article key={node.id} className="radar-row">
              <div>
                <strong>{node.title}</strong>
                <span>{humanizeIdleAge(readySince[node.id], now)}</span>
              </div>
              <button type="button" onClick={() => dispatch(node.id)}>
                Dispatch
              </button>
            </article>
          ))}
        </div>
      </section>
    </aside>
  )
}
