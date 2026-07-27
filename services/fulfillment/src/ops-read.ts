import type { FulfillmentDb } from './db.js'
import type { Tx } from './internal.js'

// The ops-portal vendor list (Task 7, check 3e sibling). vndr is PLATFORM-ONLY
// (no program_id), so this enters the ops read role bare, with no program
// scope to set; the fulfillment_ops_read grants/policies (Task 6) give broad
// operator visibility (USING(true) on vndr, matching vndr_v1's own permissive
// policy). role is a compile-time constant, never user input (safe to inline
// into $executeRawUnsafe, same reasoning as enterWriteScope/enterReadScope).
//
// NO aggregate here (a later guard scans this file): a plain row-list SELECT
// only.
export interface VendorRow {
  id: string
  type: string
  displayName: string
  status: string
  courierCode: string | null
  createdAt: Date
  updatedAt: Date
}

interface VendorDbRow {
  id: string
  type: string
  display_name: string
  status: string
  courier_code: string | null
  created_at: Date
  updated_at: Date
}

function toVendorDto(r: VendorDbRow): VendorRow {
  return {
    id: r.id,
    type: r.type,
    displayName: r.display_name,
    status: r.status,
    courierCode: r.courier_code,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function listVendors(db: FulfillmentDb): Promise<VendorRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    return tx.$queryRaw<VendorDbRow[]>`
      SELECT id, type, display_name, status, courier_code, created_at, updated_at
      FROM vndr
      ORDER BY created_at
    `
  })
  return rows.map(toVendorDto)
}
