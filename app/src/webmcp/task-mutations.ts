import type { TaskNode } from '../model/types'
import type { MutationBatchItem } from '../transport/client'

type BatchMutation = (
  batch: MutationBatchItem[],
  options: { actor: 'browser_agent' },
) => Promise<number[]>

export async function addTaskWithDependencies(
  task: TaskNode,
  dependencies: string[],
  batchMutation: BatchMutation,
  createId: () => string = () => crypto.randomUUID(),
) {
  const batch: MutationBatchItem[] = [
    { type: 'TASK_ADDED', payload: { node: task } },
    ...dependencies.map((upstream) => ({
      type: 'EDGE_ADDED' as const,
      payload: {
        edge_id: createId(),
        upstream,
        downstream: task.id,
        kind: 'depends' as const,
      },
    })),
  ]
  await batchMutation(batch, { actor: 'browser_agent' })
}
