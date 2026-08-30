export type NodeState =
  | 'queued'
  | 'running'
  | 'review'
  | 'done'
  | 'failed'
  | 'paused'

export interface TaskNode {
  id: string
  title: string
  brief: string
  estimate_min: number
  tags: string[]
  state: NodeState
}

export interface Handoff {
  v: 1
  summary: string
  files: string[]
  commits: string[]
  tests: 'green' | 'red' | 'none'
  downstream_notes: string
  deviations: string[]
  artifacts: { label: string; url: string }[]
}

export type EdgeKind = 'depends' | 'conflicts'

export interface GraphEdge {
  edge_id: string
  upstream: string
  downstream: string
  kind: EdgeKind
}

export type Actor =
  | 'human'
  | 'browser_agent'
  | 'supervisor'
  | `worker:${string}`

export interface EventPayloadMap {
  TASK_ADDED: { node: TaskNode }
  TASK_REMOVED: { node_id: string; tombstone: true }
  TASK_SPLIT: {
    parent_id: string
    children: TaskNode[]
    edge_remap: { edge_id: string; new_target: string }[]
  }
  EDGE_ADDED: {
    edge_id: string
    upstream: string
    downstream: string
    kind: EdgeKind
  }
  EDGE_REMOVED: { edge_id: string }
  DISPATCHED: {
    node_id: string
    brief_override?: string
    bypass_cap: boolean
  }
  RETRY_REQUESTED: { node_id: string; guidance: string }
  PAUSE_REQUESTED: { node_id: string }
  RESUME_REQUESTED: { node_id: string }
  APPROVED: {
    approval_id: string
    node_id: string
    policy_ref?: string
    rationale?: string
    reason?: string
  }
  REJECTED: {
    approval_id: string
    node_id: string
    policy_ref?: string
    rationale?: string
    reason?: string
  }
  POLICY_STATED: {
    policy_ref: string
    text: string
    scope: 'session'
    session_id: string
  }
  ANNOTATED: { target_id: string; note: string }
  JOURNAL_NOTE: { text: string }
  NODE_STATE_CHANGED: {
    node_id: string
    from: NodeState
    to: NodeState
    detail?: string
  }
  PAUSE_ACKED: { node_id: string }
  WORKER_LOG: { node_id: string; lines: string[] }
  HANDOFF_FILED: { node_id: string; handoff: Handoff }
  DEVIATION_NOTED: {
    node_id: string
    kind: 'estimate' | 'scope' | 'other'
    text: string
    est_min?: number
    actual_min?: number
  }
  APPROVAL_CREATED: {
    approval_id: string
    node_id: string
    summary: string
    diff_stats?: {
      lines_added: number
      lines_removed: number
      files: string[]
    }
    tests?: 'green' | 'red' | 'none'
  }
  NODE_MOVED: { node_id: string; x: number; y: number }
  SELECTION_CHANGED: { client_id: string; selected: string[] }
}

export type EvType = keyof EventPayloadMap

export interface Ev<T extends EvType, P> {
  seq: number
  project_id: string
  ts: string
  actor: Actor
  type: T
  payload: P
  idem_key: string
}

export type MissionEvent = {
  [T in EvType]: Ev<T, EventPayloadMap[T]>
}[EvType]
