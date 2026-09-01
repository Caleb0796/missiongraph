import { isReadyUnassigned, type DisplayState } from '../model/graph'
import {
  selectReplaySequenceLength,
  useMissionStore,
  type ConnectionMode,
} from '../store/mission-store'

interface PulseBarProps {
  eta: number
  counts: Record<DisplayState, number>
  onCatchUp: () => void
  onReset: () => void
  onCopyMissionLink: () => void
  onOpenFirstRun: () => void
  onReconnect: () => void
  onStartFreshMission: () => void
  onOpenStoredMission: () => void
  replaying: boolean
  replayProgress: { step: number; total: number } | null
  connectionMode: ConnectionMode
  connectionMessage: string
  linkErrorHasStoredIdentity: boolean
  contextualToolsDegraded: boolean
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="pulse-stat">
      <span className={`pulse-stat-dot ${tone}`} />
      <span className="text-slate-500">{label}</span>
      <strong className="font-mono font-medium text-slate-200">{value}</strong>
    </div>
  )
}

export function PulseBar({
  eta,
  counts,
  onCatchUp,
  onReset,
  onCopyMissionLink,
  onOpenFirstRun,
  onReconnect,
  onStartFreshMission,
  onOpenStoredMission,
  replaying,
  replayProgress,
  connectionMode,
  connectionMessage,
  linkErrorHasStoredIdentity,
  contextualToolsDegraded,
}: PulseBarProps) {
  const nodes = useMissionStore((state) => state.nodes)
  const edges = useMissionStore((state) => state.edges)
  const replaySequenceLength = useMissionStore(selectReplaySequenceLength)
  const replayTotal = replayProgress?.total ?? replaySequenceLength
  const readyCount = nodes.filter((node) =>
    isReadyUnassigned(node, nodes, edges),
  ).length

  return (
    <header className="pulse-bar">
      <div className="flex min-w-0 items-center gap-3">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-[-0.01em] text-slate-100">
            MissionGraph
          </p>
          <p className="truncate font-mono text-[9px] tracking-[0.16em] text-slate-600 uppercase">
            Shorty ·{' '}
            {connectionMode === 'live'
              ? 'live project'
              : connectionMode === 'fixture'
                ? 'fixture simulation'
                : connectionMode === 'link-error'
                  ? 'mission link unavailable'
                  : 'connecting'}
          </p>
        </div>
      </div>

      <div className="hidden items-center gap-5 lg:flex">
        <div className="pulse-eta">
          <span className="text-[10px] tracking-[0.13em] text-slate-500 uppercase">
            Critical ETA
          </span>
          <strong className="font-mono text-sm font-medium text-amber-200">
            {eta} min
          </strong>
        </div>
        <Stat label="Ready" value={readyCount} tone="bg-blue-400" />
        <Stat label="Running" value={counts.running} tone="bg-cyan-400" />
        <Stat label="Paused" value={counts.paused} tone="bg-sky-300" />
        <Stat label="Review" value={counts.review} tone="bg-amber-300" />
        <Stat label="Done" value={counts.done} tone="bg-emerald-400" />
        <Stat label="Blocked" value={counts.blocked} tone="bg-slate-500" />
        <Stat label="Failed" value={counts.failed} tone="bg-rose-400" />
      </div>

      <div className="flex items-center gap-3">
        {contextualToolsDegraded && (
          <span
            className="offline-badge"
            title="Context tools will retry after the next selection change."
          >
            Agent context limited
          </span>
        )}
        {connectionMode === 'fixture' && (
          <span className="offline-badge" title={connectionMessage}>
            {import.meta.env.PROD ? 'Offline demo data' : 'Dev fixture projection'}
          </span>
        )}
        <button
          type="button"
          className="catch-up-chip"
          onClick={onCatchUp}
        >
          {replayTotal !== null && (
            <span className="catch-up-count">{replayTotal}</span>
          )}
          {replaying && replayProgress
            ? `Replaying changes · ${replayProgress.step}/${replayProgress.total}`
            : 'Recent changes'}
        </button>
        <div className={`live-indicator live-indicator--${connectionMode}`}>
          <span className="live-dot" />
          {connectionMode === 'live'
            ? 'Live'
            : connectionMode === 'loading'
              ? 'Connecting'
              : connectionMode === 'fixture'
                ? 'Fixture'
                : 'Link expired'}
        </div>
        {connectionMode === 'link-error' && (
          <div className="connection-recovery" role="alert">
            <span>Expired or invalid mission link</span>
            <button type="button" onClick={onStartFreshMission}>
              Start a fresh mission copy
            </button>
            {linkErrorHasStoredIdentity && (
              <button type="button" onClick={onOpenStoredMission}>
                Open my stored mission
              </button>
            )}
          </div>
        )}
        {connectionMode === 'fixture' && (
          <button type="button" className="compat-link" onClick={onReconnect}>
            Reconnect
          </button>
        )}
        <button
          type="button"
          className="first-run-help"
          onClick={onOpenFirstRun}
          aria-label="Show agent prompt suggestions"
          title="Show agent prompt suggestions"
        >
          ?
        </button>
        <button
          type="button"
          className="compat-link"
          onClick={onCopyMissionLink}
          disabled={connectionMode !== 'live'}
        >
          Copy mission link
        </button>
        <a href="/compat" className="compat-link">
          Compat
        </a>
        <button type="button" className="compat-link" onClick={onReset}>
          Reset
        </button>
        {import.meta.env.DEV && (
          <a href="/tools" className="compat-link">
            Tools
          </a>
        )}
      </div>
    </header>
  )
}
