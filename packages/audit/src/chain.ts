import { createHash } from 'node:crypto'
import type { AuthzAuditRecord } from './record.js'

/**
 * The pinned known root the hash chain starts from (6e, S15). There is no
 * genesis row: the first real entry is seq 1 and its prev_hash is this
 * constant.
 */
export const GENESIS_PREV_HASH: string = '0'.repeat(64)

/**
 * Serializes the IDs-only fields of an AuthzAuditRecord in a FIXED
 * POSITIONAL array, independent of the input object's own key insertion
 * order and stable across Node versions. JSON.stringify of a fixed-position
 * array is INJECTIVE for this purpose: every control byte (including the
 * old delimiter bytes 0x1e/0x1f) is escaped by JSON's own string encoding,
 * and array element boundaries are structural, not delimiter-based, so an
 * untrusted resourceIds element can never be reshaped into a different
 * array by embedding a byte the encoding relies on (S10.5, S7).
 * resourceIds is normalized: undefined and [] MUST serialize identically,
 * because the appender stores `resourceIds ?? []` while the verifier
 * reconstructs `[]` from an empty column; they have to agree for
 * verifyAuthzChain to recompute the same hash for both.
 */
export function canonicalChainPayload(record: AuthzAuditRecord): string {
  return JSON.stringify([
    record.principalId,
    record.cls,
    record.operation,
    record.decision,
    record.outcome,
    [...(record.resourceIds ?? [])].sort(),
    record.reasonCode ?? null,
    record.acr ?? null,
    record.authTime ?? null,
    record.asserterSvid ?? null,
    record.actorChannel ?? null,
    record.traceId,
  ])
}

// Separates prevHashHex/seq/payload within the hash input. Unlike the old
// per-record-field delimiters this replaces, a fixed separator byte here is
// safe regardless of content: prevHashHex is always exactly 64 hex chars and
// seq's string form is always digits only, so neither is attacker-controlled
// or variable-length in a way that could shift a boundary.
const HASH_INPUT_SEP = '\x1f'

/**
 * The tamper-evident hash-chain link: binds this entry to its sequence
 * number and the previous entry's hash, so altering any prior entry or
 * reordering entries changes every downstream hash.
 */
export function computeEntryHash(prevHashHex: string, seq: number, record: AuthzAuditRecord): string {
  return createHash('sha256')
    .update(prevHashHex)
    .update(HASH_INPUT_SEP)
    .update(String(seq))
    .update(HASH_INPUT_SEP)
    .update(canonicalChainPayload(record))
    .digest('hex')
}
