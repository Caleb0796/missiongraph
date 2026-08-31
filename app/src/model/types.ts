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
  parent_id?: string
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

export interface HumanAuthorizationAudit {
  capability_ref: string
  policy_text?: string
  confirmed_at: string
  request_origin: string
  use_nonce: string
}

export interface GraphEdge {
  edge_id: string
  upstream: string
  downstream: string
  kind: EdgeKind
}

export interface GraphNode extends TaskNode {
  record_type: 'task' | 'group'
  child_ids: string[]
  availability: 'ready' | 'blocked' | null
  ready_since: string | null
  ever_started: boolean
  assigned: boolean
  pause_requested: boolean
}

export interface Approval {
  id: string
  node_id: string
  summary: string
  created_at: string
  created_seq: number
  status: 'pending' | 'approved' | 'rejected'
  diff_stats?: {
    lines_added: number
    lines_removed: number
    files: string[]
  }
  tests?: 'green' | 'red' | 'none'
  resolved_at?: string
  policy_ref?: string
  rationale?: string
  reason?: string
}

export type Actor =
  | 'human'
  | 'browser_agent'
  | 'supervisor'
  | `worker:${string}`

export interface EventPayloadMap {
  TASK_ADDED: { node: TaskNode }
  TASK_REMOVED: {
    node_id: string
    tombstone: true
    authorization?: HumanAuthorizationAudit
  }
  TASK_SPLIT: {
    parent_id: string
    children: TaskNode[]
    edge_remap: { edge_id: string; new_target: string }[]
    authorization?: HumanAuthorizationAudit
  }
  EDGE_ADDED: {
    edge_id: string
    upstream: string
    downstream: string
    kind: EdgeKind
    authorization?: HumanAuthorizationAudit
  }
  EDGE_REMOVED: { edge_id: string; authorization?: HumanAuthorizationAudit }
  DISPATCHED: {
    node_id: string
    brief_override?: string
    bypass_cap: boolean
    authorization?: HumanAuthorizationAudit
  }
  RETRY_REQUESTED: { node_id: string; guidance: string }
  PAUSE_REQUESTED: { node_id: string; authorization?: HumanAuthorizationAudit }
  RESUME_REQUESTED: { node_id: string; authorization?: HumanAuthorizationAudit }
  APPROVED: {
    approval_id: string
    node_id: string
    policy_ref?: string
    rationale?: string
    reason?: string
    authorization?: HumanAuthorizationAudit
  }
  REJECTED: {
    approval_id: string
    node_id: string
    policy_ref?: string
    rationale?: string
    reason?: string
    authorization?: HumanAuthorizationAudit
  }
  POLICY_STATED: {
    policy_ref: string
    text: string
    scope: 'session'
    session_id: string
    allowed_actions?: ('approve' | 'reject')[]
    max_uses?: number
    expires_at?: string
    confirmed_at?: string
    request_origin?: string
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

export interface GraphSnapshotState {
  v: 1
  seq: number
  nodes: Record<string, GraphNode>
  edges: Record<
    string,
    {
      id: string
      upstream: string
      downstream: string
      kind: EdgeKind
    }
  >
  tombstones: Record<
    string,
    { node: TaskNode; removed_at: string; removed_seq: number }
  >
  approvals: Record<string, Approval>
  policies: Record<
    string,
    { text: string; session_id: string; stated_at: string }
  >
  annotations: Record<
    string,
    { actor: string; note: string; ts: string }[]
  >
  journal: { actor: string; text: string; ts: string; seq: number }[]
  handoffs: Record<string, Handoff>
  deviations: Record<
    string,
    {
      kind: 'estimate' | 'scope' | 'other'
      text: string
      est_min?: number
      actual_min?: number
      ts: string
    }[]
  >
  worker_logs: Record<string, string[]>
  positions: Record<string, { x: number; y: number }>
  selections: Record<string, string[]>
  critical_path: string[]
}

export interface DigestChange {
  seq: number
  actor: Actor
  type: EvType
  one_liner: string
  policy_ref?: string
  authorization?: {
    capability_ref: string
    use_nonce: string
  }
}

export interface GraphDigest {
  summary: {
    counts_by_state: Record<
      'ready' | 'blocked' | 'running' | 'review' | 'done' | 'failed' | 'paused',
      number
    >
    critical_path_node_ids: string[]
    pending_approvals: {
      approval_id: string
      node_id: string
      node_title: string
      summary: string
      delay_impact_min: number
      age_since: string
    }[]
    ready_unassigned: {
      node_id: string
      node_title: string
      idle_since: string
      on_critical_path: boolean
    }[]
  }
  changes_since: DigestChange[]
  cursor: string
}
