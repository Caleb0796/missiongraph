export interface StructuralOperationProposal {
  children: { id: string; title: string }[]
  edgeRemap: {
    edgeId: string
    upstream: string
    upstreamTitle: string
    downstream: string
    downstreamTitle: string
    kind: 'depends' | 'conflicts'
  }[]
}

export interface StructuralOperationSnapshot {
  key: string
  opToken: string
  title: string
  ids: string[]
  notice?: string
  proposal?: StructuralOperationProposal
  baseCursor: string
  projectId: string | null
}

export interface StructuralOperationPlan {
  title: string
  ids: string[]
  notice?: string
  proposal?: StructuralOperationProposal
  apply: () => Promise<unknown>
}

interface PendingStructuralOperation extends StructuralOperationSnapshot {
  recompute: () => StructuralOperationPlan
  apply: () => Promise<unknown>
}

export type StructuralOperationResult =
  | { applied: false; operation: StructuralOperationSnapshot }
  | { applied: true; value: unknown }

function snapshot(operation: PendingStructuralOperation) {
  return {
    key: operation.key,
    opToken: operation.opToken,
    title: operation.title,
    ids: [...operation.ids],
    ...(operation.notice ? { notice: operation.notice } : {}),
    ...(operation.proposal
      ? {
          proposal: {
            children: operation.proposal.children.map((child) => ({ ...child })),
            edgeRemap: operation.proposal.edgeRemap.map((remap) => ({
              ...remap,
            })),
          },
        }
      : {}),
    baseCursor: operation.baseCursor,
    projectId: operation.projectId,
  }
}

export class StructuralConfirmationController {
  private pending: PendingStructuralOperation | null = null
  private readonly makeToken: () => string

  constructor(makeToken: () => string = () => crypto.randomUUID()) {
    this.makeToken = makeToken
  }

  stage(operation: {
    key: string
    cursor: string
    projectId: string | null
    recompute: () => StructuralOperationPlan
  }) {
    const plan = operation.recompute()
    this.pending = {
      key: operation.key,
      opToken: this.makeToken(),
      title: plan.title,
      ids: [...plan.ids],
      ...(plan.notice ? { notice: plan.notice } : {}),
      ...(plan.proposal ? { proposal: plan.proposal } : {}),
      baseCursor: operation.cursor,
      projectId: operation.projectId,
      recompute: operation.recompute,
      apply: plan.apply,
    }
    return snapshot(this.pending)
  }

  cancel() {
    this.pending = null
  }

  private rebind(pending: PendingStructuralOperation, cursor: string) {
    const plan = pending.recompute()
    pending.opToken = this.makeToken()
    pending.title = plan.title
    pending.ids = [...plan.ids]
    pending.notice = plan.notice
    pending.proposal = plan.proposal
    pending.baseCursor = cursor
    pending.apply = plan.apply
    return { applied: false, operation: snapshot(pending) } as const
  }

  async confirm(
    key: string,
    opToken: string,
    context: { cursor: string; projectId: string | null },
    readContext: () => { cursor: string; projectId: string | null },
    isStaleError: (error: unknown) => boolean,
  ): Promise<StructuralOperationResult> {
    const pending = this.pending
    if (!pending || pending.key !== key || pending.opToken !== opToken) {
      throw new Error('op_token is missing, expired, or does not match this operation.')
    }
    if (pending.projectId !== context.projectId) {
      this.pending = null
      throw new Error('The project changed after this preview. Start the operation again.')
    }
    if (pending.baseCursor !== context.cursor) {
      return this.rebind(pending, context.cursor)
    }
    try {
      const value = await pending.apply()
      if (this.pending === pending) this.pending = null
      return { applied: true, value }
    } catch (error) {
      if (!isStaleError(error)) throw error
      const latest = readContext()
      if (pending.projectId !== latest.projectId) {
        this.pending = null
        throw new Error('The project changed after this preview. Start the operation again.')
      }
      return this.rebind(pending, latest.cursor)
    }
  }
}
