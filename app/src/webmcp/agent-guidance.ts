export function policyConfirmationNextStep(cursor: string) {
  return `Ask the human to confirm in the page, then call graph_digest with cursor ${cursor}; the POLICY_STATED entry carries policy_ref — draft_id is not a policy_ref.`
}

export function capabilityRequiredNextStep(
  toolName: string,
  cursor: string,
) {
  if (toolName === 'approve') {
    return `Call state_policy with the human-stated policy text. Ask the human to confirm it in the page, then call graph_digest with cursor ${cursor}; read POLICY_STATED.policy_ref and call approve again with that policy_ref. draft_id is not a policy_ref.`
  }
  if (toolName === 'dispatch') {
    return `Call list_ready, then call dispatch with a ready task id. Ask the human to confirm the staged dispatch in the page, then call graph_digest with cursor ${cursor} to verify the DISPATCHED entry.`
  }
}
