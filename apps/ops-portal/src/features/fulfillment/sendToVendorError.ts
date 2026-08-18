import { conflictReasonCode } from '../../api/endpoints.js'

// WHY SEND-TO-VENDOR WAS REFUSED, in the operator's words.
//
// Written 19 Aug 2026 after a demo run stalled on it. The batch page showed
// "That conflicts with a change someone else made. Reload and try again." and
// reloading changed nothing, because nobody else had changed anything: there
// were TWO active print vendors, and D-9a binds a batch to the single active one,
// so the domain could not choose. The operator had no way to learn that from the
// screen, and the fix (suspend one of them in Master Data) is thirty seconds
// once you know.
//
// The generic sentence is the api/errors.ts floor for a 409, and it was the only
// thing available: the domain's own message never crosses the HTTP boundary
// (S4/5c). What crosses now is a closed reason code, so the wording below is the
// PORTAL's (P1-1c) and each sentence names the actual next move.
//
// Every code here comes from sendBatchToVendor in services/fulfillment/src/ops.ts.
// An unknown code falls through to the caller's own fallback rather than being
// guessed at, so a reason added there without a sentence here reads as a plain
// failure instead of the wrong explanation.
const SEND_CONFLICT_COPY: Record<string, string> = {
  'print-vendor-not-unique':
    'This batch cannot be bound to a print vendor: exactly one PRINT vendor must be active, and right now that is not the case. Fix the roster under Master Data, then send again.',
  'batch-already-sent': 'This batch has already gone to the print vendor. Reload to see its current state.',
  'qr-generation-incomplete':
    'The QR cards for this batch are not all composed yet. Give it a moment and try again; nothing has been sent.',
  'batch-empty': 'This batch holds no dispatches to send.',
}

/** The codes this file has a sentence for. Asserted against the service's own
 *  throws by test/send_conflict_reason_parity.test.ts, because a code added
 *  there without a sentence here fails nothing and silently reverts the
 *  operator to the generic message. */
export const SEND_CONFLICT_CODES: readonly string[] = Object.keys(SEND_CONFLICT_COPY)

/**
 * The message to show when sending a batch to the print vendor fails.
 *
 * `fallback` is the caller's own sentence, used for anything that is not a coded
 * conflict, so a network drop or a 500 still reads the way it did before.
 */
export function sendToVendorErrorMessage(err: unknown, fallback: string): string {
  const code = conflictReasonCode(err)
  if (code !== null) {
    const copy = SEND_CONFLICT_COPY[code]
    if (copy !== undefined) return copy
  }
  return err instanceof Error ? err.message : fallback
}
