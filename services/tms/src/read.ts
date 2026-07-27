import type { TmsDb } from './db.js'
import { enterReadScope } from './read-context.js'

// D-6 (spec 10b): the tenant read API. Curated, row-level assignment reads
// for the tenant class-2 READ portal (a later task's HTTP edge calls this
// in-process). Reads ONLY the tms schema (C4): no other context's schema, no
// cross-context source import, no HTTP dependency.
//
// programIds is the ONLY program-scope input; there is no other parameter a
// caller could use to widen scope. It is the primary application predicate
// (WHERE program_id = ANY(...)); the RESTRICTIVE assignment_tenant_read RLS
// policy under tms_read is the backstop, not the only gate (defense in
// depth). Includes the bank's own ship-to recipient PII (contact_name,
// mobile, ship_to_address) for its own Program rows (Fork F); never logged.
export interface AssignmentReadRow {
  id: string
  merchantId: string
  programId: string
  tenantId: string
  merchantDisplayName: string
  bankDisplayName: string
  bankReferenceCode: string
  shipToAddress: string
  contactName: string | null
  mobile: string | null
  demandState: string
  soundbox: boolean
  standeeCount: number
  stickerCount: number
  activatedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

// The exact (aliased) snake_case shape of the curated SELECT below, typed
// directly against $queryRaw so the result needs no cast.
interface AssignmentReadDbRow {
  id: string
  merchant_id: string
  program_id: string
  tenant_id: string
  merchant_display_name: string
  bank_display_name: string
  bank_reference_code: string
  ship_to_address: string
  contact_name: string | null
  mobile: string | null
  demand_state: string
  soundbox: boolean
  standee_count: number
  sticker_count: number
  activated_at: Date | null
  created_at: Date
  updated_at: Date
}

function toDto(r: AssignmentReadDbRow): AssignmentReadRow {
  return {
    id: r.id,
    merchantId: r.merchant_id,
    programId: r.program_id,
    tenantId: r.tenant_id,
    merchantDisplayName: r.merchant_display_name,
    bankDisplayName: r.bank_display_name,
    bankReferenceCode: r.bank_reference_code,
    shipToAddress: r.ship_to_address,
    contactName: r.contact_name,
    mobile: r.mobile,
    demandState: r.demand_state,
    soundbox: r.soundbox,
    standeeCount: r.standee_count,
    stickerCount: r.sticker_count,
    activatedAt: r.activated_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function readAssignments(db: TmsDb, programIds: string[]): Promise<AssignmentReadRow[]> {
  // fail-closed empty scope: no entitled Program means no rows, without ever
  // reaching the database.
  if (programIds.length === 0) return []
  const arrayLiteral = `{${programIds.join(',')}}`
  const rows = await db.$transaction(async (tx) => {
    await enterReadScope(tx, 'tms_read', programIds)
    return tx.$queryRaw<AssignmentReadDbRow[]>`
      SELECT id, merchant_id, program_id, tenant_id, merchant_display_name, bank_display_name,
             bank_reference_code, ship_to_address, contact_name, mobile, demand_state, soundbox,
             standee_count, sticker_count, activated_at, created_at, updated_at
      FROM assignment
      WHERE program_id = ANY(${arrayLiteral}::uuid[])
    `
  })
  return rows.map(toDto)
}

export async function readAssignmentById(
  db: TmsDb,
  programIds: string[],
  id: string,
): Promise<AssignmentReadRow | null> {
  if (programIds.length === 0) return null
  const arrayLiteral = `{${programIds.join(',')}}`
  const rows = await db.$transaction(async (tx) => {
    await enterReadScope(tx, 'tms_read', programIds)
    return tx.$queryRaw<AssignmentReadDbRow[]>`
      SELECT id, merchant_id, program_id, tenant_id, merchant_display_name, bank_display_name,
             bank_reference_code, ship_to_address, contact_name, mobile, demand_state, soundbox,
             standee_count, sticker_count, activated_at, created_at, updated_at
      FROM assignment
      WHERE program_id = ANY(${arrayLiteral}::uuid[]) AND id = ${id}::uuid
    `
  })
  const row = rows[0]
  return row ? toDto(row) : null
}
