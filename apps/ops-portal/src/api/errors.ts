// The message an operator ends up reading when nothing more specific catches
// the failure first.
//
// It used to be `api ${status}`, and that string really did reach the screen:
// every collateral download failure rendered a red banner saying "api 500",
// which tells the person nothing they can act on and reads like debug output
// left in by accident. P1-1c makes the PORTAL the owner of operator-facing
// wording, so the fallback has to be a sentence.
//
// Screens that can say something better still should, and several already do
// (the uploads pages map structural reasons to per-column messages, and the
// login page reads `status` directly). This is only the floor.
//
// `status` and `body` are unchanged and remain the programmatic contract: every
// `err instanceof ApiError && err.status === 403` check keeps working, and
// nothing here should ever be parsed.
function operatorMessage(status: number): string {
  if (status === 401) return 'Your session is no longer valid. Sign in again.'
  if (status === 403) return 'You do not have permission to do that.'
  if (status === 404) return 'That is no longer there. It may have been changed by someone else.'
  if (status === 409) return 'That conflicts with a change someone else made. Reload and try again.'
  if (status === 413) return 'That file is too large to upload.'
  if (status === 429) return 'Too many requests just now. Wait a moment and try again.'
  // A 5xx is OURS, and saying so matters: the operator should not go hunting
  // for a mistake they did not make. Deliberately NOT "nothing was changed",
  // because a 500 cannot promise that.
  if (status >= 500) return `Something went wrong on our side (${status}). Try again, and tell the team if it persists.`
  return `That request was rejected (${status}).`
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(operatorMessage(status))
    this.name = 'ApiError'
  }
}
