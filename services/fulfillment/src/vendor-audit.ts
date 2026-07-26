import { enqueue } from '@andpay/outbox'
import { buildAuthzAuditEvent, type AuthzAuditRecord } from '@andpay/audit'
import type { FulfillmentDb } from './db.js'
import type { Tx } from './internal.js'

// The vendor-edge's own 6e emission (check 6, D10 of the spec-10a plan): the
// edge (apps/vendor-edge) resolves and authorizes a class-6 claim LOCALLY with
// zero call to Auth, then commits ONE authz-audit outbox row in its OWN short
// transaction, separate from any handler transaction (the handler
// ingestX(...) opens and commits its own tx independently; a DENY never even
// reaches the handler). E1: this fact and the edge's decision commit or roll
// back together, never partially. IDs and enums only (S7/S10.5), never a
// secret or PII; the presented credential never rides this record.
export async function emitVendorAuthzAudit(
  db: FulfillmentDb,
  record: AuthzAuditRecord,
  eventId?: string,
): Promise<void> {
  await db.$transaction(async (tx: Tx) => {
    await enqueue(tx, buildAuthzAuditEvent(record, eventId))
  })
}
