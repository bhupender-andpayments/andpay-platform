import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEND_CONFLICT_CODES } from '../apps/ops-portal/src/features/fulfillment/sendToVendorError.js'

// Parity guard, the same shape as test/courier_status_parity.test.ts and for the
// same reason: the portal cannot import from a service (C4), so a value set both
// sides depend on is duplicated, and a hand-copied list drifts silently.
//
// WHAT DRIFTS HERE, and why silence is the danger. sendBatchToVendor refuses for
// four different reasons with four different answers, and the domain's own
// message never crosses the HTTP boundary (S4/5c), so all the operator gets is a
// closed reason code and whatever sentence the portal has for it. A code added on
// the service side with no sentence here does not fail anything: the operator
// just falls back to "that conflicts with a change someone else made, reload and
// try again", which is exactly the unactionable message this whole mechanism was
// added on 19 Aug 2026 to replace. A demo stalled on it for want of the sentence
// "exactly one PRINT vendor must be active".
//
// Reads the service SOURCE as text rather than importing it, because the point is
// that no import links these two files.
const root = join(import.meta.dirname, '..')

/** The reason codes sendBatchToVendor can throw, read out of its own body. */
function serviceCodes(): string[] {
  const text = readFileSync(join(root, 'services', 'fulfillment', 'src', 'ops.ts'), 'utf8')
  const start = text.indexOf('export async function sendBatchToVendor(')
  expect(start).toBeGreaterThan(-1)
  // The next top-level export bounds the function; every throw inside it belongs
  // to this action, including the one in its PrintVendorNotResolvableError catch.
  const end = text.indexOf('\nexport ', start + 1)
  const body = text.slice(start, end === -1 ? text.length : end)
  const codes = [...body.matchAll(/\{\s*code:\s*'([a-z0-9-]+)'\s*\}/g)].map((m) => m[1]!)
  return [...new Set(codes)]
}

describe('send-to-vendor conflict reason parity between services/fulfillment and apps/ops-portal', () => {
  it('finds every refusal code on the service side', () => {
    // Four refusals: empty batch, unfinished QR generation, already sent, and the
    // print-vendor roster. Pinned as a count so deleting one is deliberate.
    expect(serviceCodes()).toHaveLength(4)
  })

  it('the portal has a sentence for exactly the codes the service throws', () => {
    expect([...SEND_CONFLICT_CODES].sort()).toEqual([...serviceCodes()].sort())
  })
})
