export interface ConfirmationIdentity {
  id: string
  textHash?: string
}

export class ConfirmationBusyError extends Error {
  readonly code = 'confirmation_busy'

  constructor() {
    super(
      'Another human confirmation is already pending; resolve it before staging a new one.',
    )
    this.name = 'ConfirmationBusyError'
  }
}

export function requireConfirmationSlot(
  current: ConfirmationIdentity | null,
) {
  if (current) throw new ConfirmationBusyError()
}

export function confirmationMatches(
  current: ConfirmationIdentity | null,
  id: string,
  textHash?: string,
) {
  return current?.id === id && current.textHash === textHash
}
