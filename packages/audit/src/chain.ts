import { createHash } from 'node:crypto'
import type { AuthzAuditRecord } from './record.js'

/**
 * The pinned known root the hash chain starts from (6e, S15). There is no
 * genesis row: the first real entry is seq 1 and its prev_hash is this
 * constant.
 */
export const GENESIS_PREV_HASH: string = '0'.repeat(64)

// Field and array delimiters that cannot appear in the IDs-only data this
// record carries (S10.5, S7), so the canonical serialization stays
// unambiguous without relying on JSON.stringify key order.
const FIELD_SEP = '\x1f'
const ARRAY_SEP = '\x1e'

function field(value: string | number | undefined): string {
  return value === undefined ? '' : String(value)
}

/**
 * Serializes the IDs-only fields of an AuthzAuditRecord in a FIXED key order,
 * independent of the input object's own key insertion order and stable
 * across Node versions. resourceIds is rendered from a sorted copy joined
 * with a distinct delimiter so the array boundary stays unambiguous.
 */
export function canonicalChainPayload(record: AuthzAuditRecord): string {
  const resourceIds = record.resourceIds ? [...record.resourceIds].sort().join(ARRAY_SEP) : ''
  return [
    field(record.principalId),
    field(record.cls),
    field(record.operation),
    field(record.decision),
    field(record.outcome),
    resourceIds,
    field(record.reasonCode),
    field(record.acr),
    field(record.authTime),
    field(record.asserterSvid),
    field(record.actorChannel),
    field(record.traceId),
  ].join(FIELD_SEP)
}

/**
 * The tamper-evident hash-chain link: binds this entry to its sequence
 * number and the previous entry's hash, so altering any prior entry or
 * reordering entries changes every downstream hash.
 */
export function computeEntryHash(prevHashHex: string, seq: number, record: AuthzAuditRecord): string {
  return createHash('sha256')
    .update(prevHashHex)
    .update(FIELD_SEP)
    .update(String(seq))
    .update(FIELD_SEP)
    .update(canonicalChainPayload(record))
    .digest('hex')
}
