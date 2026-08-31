export interface StructuralOperationSnapshot {
  key: string
  opToken: string
  title: string
  ids: string[]
  baseCursor: string
  projectId: string | null
}

interface PendingStructuralOperation extends StructuralOperationSnapshot {
  prepare: () => () => Promise<unknown>
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

  stage(
    operation: Omit<StructuralOperationSnapshot, 'opToken' | 'baseCursor'> & {
      cursor: string
      prepare: () => () => Promise<unknown>
    },
  ) {
    const apply = operation.prepare()
    this.pending = {
      key: operation.key,
      opToken: this.makeToken(),
      title: operation.title,
      ids: [...operation.ids],
      baseCursor: operation.cursor,
      projectId: operation.projectId,
      prepare: operation.prepare,
      apply,
    }
    return snapshot(this.pending)
  }

  cancel() {
    this.pending = null
  }

  async confirm(
    key: string,
    opToken: string,
    cursor: string,
    projectId: string | null,
  ): Promise<StructuralOperationResult> {
    const pending = this.pending
    if (!pending || pending.key !== key || pending.opToken !== opToken) {
      throw new Error('op_token is missing, expired, or does not match this operation.')
    }
    if (pending.projectId !== projectId) {
      this.pending = null
      throw new Error('The project changed after this preview. Start the operation again.')
    }
    if (pending.baseCursor !== cursor) {
      const apply = pending.prepare()
      pending.opToken = this.makeToken()
      pending.baseCursor = cursor
      pending.apply = apply
      return { applied: false, operation: snapshot(pending) }
    }
    this.pending = null
    return { applied: true, value: await pending.apply() }
  }
}
