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

export interface HistoryRow {
  btchId: string
  awb: string
  shptStatus: string
  dispatchDate: string
  deviceSerial: string | null
}

// The vendor dispatch history: own-vndr dispatched units (unit.shipment set),
// joined to their shpt for the AWB + carrier status. Join path: shpt <- unit
// ON unit.shipment = shpt.id, unit.batch -> batch.print_vndr (the vndr axis
// lives only on batch; shpt itself carries no vndr). No direct asgn linkage
// exists on unit (only batch/shipment/printed_for_merchant), and the fuzzy
// merchant_id+batch join to pending_pool_entry.asgn_id can be non-unique
// within a batch, so asgnId is deliberately dropped from this projection
// rather than invented. PII-free by column projection (never selects
// unit.sim_no, unit.device_qr, or any ship_to* column); device_serial is a
// vendor-submitted hardware serial, not recipient PII. Runs under the
// fulfillment_vendor_read role so the RESTRICTIVE RLS is the DB-level
// backstop; the query itself does not hand-filter on print_vndr.
export async function readVendorHistory(db: FulfillmentDb, scopeVndrWire: string): Promise<HistoryRow[]> {
  const vndrUuid = toUuid(scopeVndrWire)
  return db.$transaction(async (tx) => {
    await enterVendorReadScope(tx, vndrUuid)
    const rows = await tx.$queryRaw<
      { btch_id: string; awb: string; shpt_status: string; dispatch_date: Date; device_serial: string | null }[]
    >`
      SELECT u.batch::text AS btch_id, s.awb AS awb, s.status AS shpt_status,
             s.dispatch_date AS dispatch_date, u.device_serial AS device_serial
      FROM unit u
      JOIN shpt s ON s.id = u.shipment
      WHERE u.shipment IS NOT NULL
      ORDER BY s.dispatch_date DESC
    `
    return rows.map((r) => ({
      btchId: fromUuid('btch', r.btch_id),
      awb: r.awb,
      shptStatus: r.shpt_status,
      dispatchDate: r.dispatch_date.toISOString(),
      deviceSerial: r.device_serial,
    }))
  })
}
