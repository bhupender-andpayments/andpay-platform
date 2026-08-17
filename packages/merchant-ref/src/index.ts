// The bank merchant reference: the string the Identity-owned resolver
// (merchant_bank_ref, Fork B, spec 05) is keyed on, alongside the tenant.
//
// WHAT IT IS. D1: merchant identity is the VPA FOR NOW. The reference is that
// VPA in a versioned envelope, `v1:vpa:<lowercased vpa>`. The `v1:` marker is
// not decoration; it is what lets D1's expected re-key land as a new version
// beside the old references rather than as a rewrite of every stored row.
//
// WHY THIS IS A SHARED PACKAGE AND NOT A SERVICE MODULE. Two contexts must
// derive the SAME reference for one merchant, and neither may import the
// other's source (C4). It is the @andpay/bank-qr situation exactly:
//
//   TMS PRODUCES it, in the bank-file profile (bank-source-profile.ts), for
//     every row of every ingested file.
//   IDENTITY PRODUCES it, in the ops create path (ops.ts createMerchant), for
//     the merchant an operator adds by hand before any file mentions them.
//
// The two must agree BYTE FOR BYTE or the feature silently fails: the manual
// create writes a resolver row, the bank file arrives later, computes a
// reference one character different, misses, and mints a SECOND merchant for
// the same shop. That is the exact fault the manual-create path exists to
// avoid, and a second copy of this rule is how it would come back.
//
// SUBMITTED, NOT RATIFIED. This package's existence and its placement are
// item 2 of docs/plan/CORPUS_SUBMISSION_2026-08-17_MERCHANT_CREATE.md. It is
// deliberately NOT in @andpay/keys: that package is the 06.A idempotency key
// grammar, pipe delimited and validated as such, and this is neither an
// idempotency key nor pipe delimited.

/** The version marker D1's expected re-key will move. */
export const MERCHANT_REFERENCE_VERSION = 'v1'

/**
 * Derive the bank merchant reference from a merchant's VPA.
 *
 * Lowercased and trimmed, so a casing or whitespace difference between a bank
 * file and an operator's typing cannot mint a second merchant for one shop.
 *
 * A BLANK VPA YIELDS THE EMPTY REFERENCE, not a bare `v1:vpa:` prefix. This
 * function decides the grammar, never the policy: a bare prefix would be one
 * reference that every VPA-less row in the platform collides on, whereas the
 * empty string is what each caller already rejects in its own terms (the
 * ingest row validator rejects the row; the manual create returns a 4xx naming
 * the field). Neither caller should have to know the other's error surface.
 */
export function merchantBankReference(vpa: string): string {
  const normalized = vpa.trim().toLowerCase()
  if (normalized === '') return ''
  return `${MERCHANT_REFERENCE_VERSION}:vpa:${normalized}`
}
