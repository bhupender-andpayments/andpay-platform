import type { FulfillmentDb } from './db.js'
import { enterReadScope } from './read-context.js'

// D-6 (spec 10b): the tenant read API. Curated, program-scoped shipment reads
// for the tenant class-2 READ portal (a later task's HTTP edge calls this
// in-process). Reads ONLY the fulfillment schema (C4): no other context's
// schema, no cross-context source import, no HTTP dependency.
//
// programIds is the ONLY program-scope input; there is no other parameter a
// caller could use to widen scope. It is the primary application predicate
// (WHERE program_id = ANY(...)); the RESTRICTIVE shpt_tenant_read /
// shpt_status_event_tenant_read RLS policies under fulfillment_read are the
// backstop, not the only gate (defense in depth). These DTOs carry NO
// recipient PII: shpt/shpt_status_event are AWB and carrier-status only (the
// ship-to PII lives on tms.assignment, handled in Task 3).
export interface ShipmentReadRow {
  id: string
  awb: string
  status: string
  courierPartner: string | null
  dispatchDate: Date
  programId: string
  tenantId: string
  statusAt: Date | null
  statusSource: string | null
  createdAt: Date
  updatedAt: Date
}

export interface ShipmentStatusEventRow {
  id: string
  shptId: string
  status: string
  occurredAt: Date
  programId: string
  source: string | null
}

// The exact (aliased) snake_case shape of the curated SELECT below, typed
// directly against $queryRaw so the result needs no cast.
interface ShipmentReadDbRow {
  id: string
  awb: string
  status: string
  courier_partner: string | null
  dispatch_date: Date
  program_id: string
  tenant_id: string
  status_at: Date | null
  status_source: string | null
  created_at: Date
  updated_at: Date
}

interface ShipmentStatusEventDbRow {
  id: string
  shpt_id: string
  status: string
  courier_timestamp: Date
  program_id: string
  status_source: string | null
}

function toShipmentDto(r: ShipmentReadDbRow): ShipmentReadRow {
  return {
    id: r.id,
    awb: r.awb,
    status: r.status,
    courierPartner: r.courier_partner,
    dispatchDate: r.dispatch_date,
    programId: r.program_id,
    tenantId: r.tenant_id,
    statusAt: r.status_at,
    statusSource: r.status_source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function toStatusEventDto(r: ShipmentStatusEventDbRow): ShipmentStatusEventRow {
  return {
    id: r.id,
    shptId: r.shpt_id,
    status: r.status,
    occurredAt: r.courier_timestamp,
    programId: r.program_id,
    source: r.status_source,
  }
}

export async function readShipments(db: FulfillmentDb, programIds: string[]): Promise<ShipmentReadRow[]> {
  // fail-closed empty scope: no entitled Program means no rows, without ever
  // reaching the database.
  if (programIds.length === 0) return []
  const arrayLiteral = `{${programIds.join(',')}}`
  const rows = await db.$transaction(async (tx) => {
    await enterReadScope(tx, 'fulfillment_read', programIds)
    return tx.$queryRaw<ShipmentReadDbRow[]>`
      SELECT id, awb, status, courier_partner, dispatch_date, program_id, tenant_id,
             status_at, status_source, created_at, updated_at
      FROM shpt
      WHERE program_id = ANY(${arrayLiteral}::uuid[])
    `
  })
  return rows.map(toShipmentDto)
}

export async function readShipmentStatusTrail(
  db: FulfillmentDb,
  programIds: string[],
  shptId: string,
): Promise<ShipmentStatusEventRow[]> {
  if (programIds.length === 0) return []
  const arrayLiteral = `{${programIds.join(',')}}`
  const rows = await db.$transaction(async (tx) => {
    await enterReadScope(tx, 'fulfillment_read', programIds)
    return tx.$queryRaw<ShipmentStatusEventDbRow[]>`
      SELECT id, shpt_id, status, courier_timestamp, program_id, status_source
      FROM shpt_status_event
      WHERE program_id = ANY(${arrayLiteral}::uuid[]) AND shpt_id = ${shptId}::uuid
      ORDER BY courier_timestamp ASC
    `
  })
  return rows.map(toStatusEventDto)
}
