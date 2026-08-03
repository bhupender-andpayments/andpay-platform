import { toUuid, fromUuid } from '@andpay/ids'
import type { FulfillmentDb } from './db.js'
import { enterVendorReadScope } from './vendor-read-context.js'

export interface WorkQueueRow {
  btchId: string
  unitCount: number
  status: string
  openEntries: number // entries not yet DISPATCHED_BY_VENDOR
  createdAt: string
}

// The vendor work-queue: own-vndr batches that still have entries not yet
// returned (dispatch_state IS DISTINCT FROM 'DISPATCHED_BY_VENDOR'). PII-free
// by column projection: never selects any ship_to* column. Runs under the
// fulfillment_vendor_read role so the RESTRICTIVE RLS is the DB-level backstop
// (the join is anchored on batch, but isolation does NOT rest on that).
export async function readVendorWorkQueue(db: FulfillmentDb, scopeVndrWire: string): Promise<WorkQueueRow[]> {
  const vndrUuid = toUuid(scopeVndrWire)
  return db.$transaction(async (tx) => {
    await enterVendorReadScope(tx, vndrUuid)
    const rows = await tx.$queryRaw<
      { btch_id: string; unit_count: number; status: string; open_entries: bigint; created_at: Date }[]
    >`
      SELECT b.id::text AS btch_id, b.unit_count, b.status,
             count(p.id) FILTER (WHERE p.dispatch_state IS DISTINCT FROM 'DISPATCHED_BY_VENDOR') AS open_entries,
             b.created_at
      FROM batch b
      JOIN pending_pool_entry p ON p.batch = b.id
      GROUP BY b.id, b.unit_count, b.status, b.created_at
      HAVING count(p.id) FILTER (WHERE p.dispatch_state IS DISTINCT FROM 'DISPATCHED_BY_VENDOR') > 0
      ORDER BY b.created_at DESC
    `
    return rows.map((r) => ({
      btchId: fromUuid('btch', r.btch_id),
      unitCount: r.unit_count,
      status: r.status,
      openEntries: Number(r.open_entries),
      createdAt: r.created_at.toISOString(),
    }))
  })
}
