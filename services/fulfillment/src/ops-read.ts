import { fromUuid } from '@andpay/ids'
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
    id: fromUuid('vndr', r.id),
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

// The two fulfillment exception surfaces (spec 10c Task 8, check 9): both
// `intake_exception` and `courier_status_exception` are PLATFORM-ONLY
// (permissive FORCE RLS, no program_id column), so these enter the ops read
// role bare, exactly like `listVendors` above. Neither table is granted to
// `fulfillment_read` (the tenant read role, tightened in
// 20260727000200_tighten_read_grants to the five tenant-facing tables only),
// so a read attempt under that role hits a Postgres permission-denied error,
// not an empty result (check 9 exclusion, asserted in ops-exceptions.test.ts).
//
// NO aggregate here (a later guard scans this file): a plain row-list SELECT
// only, `WHERE resolved_at IS NULL` unless the caller opts into resolved rows.
export interface IntakeExceptionView {
  id: string
  vndrId: string
  fileId: string
  rowRef: string
  reasonCode: string
  createdAt: Date
  resolvedAt: Date | null
  resolvedByActor: string | null
}

interface IntakeExceptionDbRow {
  id: string
  vndr_id: string
  file_id: string
  row_ref: string
  reason_code: string
  created_at: Date
  resolved_at: Date | null
  resolved_by_actor: string | null
}

function toIntakeExceptionDto(r: IntakeExceptionDbRow): IntakeExceptionView {
  return {
    id: r.id,
    vndrId: fromUuid('vndr', r.vndr_id),
    fileId: r.file_id,
    rowRef: r.row_ref,
    reasonCode: r.reason_code,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedByActor: r.resolved_by_actor,
  }
}

export async function readIntakeExceptions(
  db: FulfillmentDb,
  { includeResolved }: { includeResolved: boolean },
): Promise<IntakeExceptionView[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    if (includeResolved) {
      return tx.$queryRaw<IntakeExceptionDbRow[]>`
        SELECT id::text AS id, vndr_id::text AS vndr_id, file_id, row_ref, reason_code, created_at,
               resolved_at, resolved_by_actor::text AS resolved_by_actor
        FROM intake_exception
        ORDER BY created_at
      `
    }
    return tx.$queryRaw<IntakeExceptionDbRow[]>`
      SELECT id::text AS id, vndr_id::text AS vndr_id, file_id, row_ref, reason_code, created_at,
             resolved_at, resolved_by_actor::text AS resolved_by_actor
      FROM intake_exception
      WHERE resolved_at IS NULL
      ORDER BY created_at
    `
  })
  return rows.map(toIntakeExceptionDto)
}

export interface CourierStatusExceptionView {
  id: string
  vndrId: string
  channel: string
  subjectRef: string
  fileId: string | null
  rowRef: string | null
  reasonCode: string
  createdAt: Date
  resolvedAt: Date | null
  resolvedByActor: string | null
}

interface CourierStatusExceptionDbRow {
  id: string
  vndr_id: string
  channel: string
  subject_ref: string
  file_id: string | null
  row_ref: string | null
  reason_code: string
  created_at: Date
  resolved_at: Date | null
  resolved_by_actor: string | null
}

function toCourierStatusExceptionDto(r: CourierStatusExceptionDbRow): CourierStatusExceptionView {
  return {
    id: r.id,
    vndrId: fromUuid('vndr', r.vndr_id),
    channel: r.channel,
    subjectRef: r.subject_ref,
    fileId: r.file_id,
    rowRef: r.row_ref,
    reasonCode: r.reason_code,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedByActor: r.resolved_by_actor,
  }
}

export async function readCourierStatusExceptions(
  db: FulfillmentDb,
  { includeResolved }: { includeResolved: boolean },
): Promise<CourierStatusExceptionView[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    if (includeResolved) {
      return tx.$queryRaw<CourierStatusExceptionDbRow[]>`
        SELECT id::text AS id, vndr_id::text AS vndr_id, channel, subject_ref, file_id, row_ref,
               reason_code, created_at, resolved_at, resolved_by_actor::text AS resolved_by_actor
        FROM courier_status_exception
        ORDER BY created_at
      `
    }
    return tx.$queryRaw<CourierStatusExceptionDbRow[]>`
      SELECT id::text AS id, vndr_id::text AS vndr_id, channel, subject_ref, file_id, row_ref,
             reason_code, created_at, resolved_at, resolved_by_actor::text AS resolved_by_actor
      FROM courier_status_exception
      WHERE resolved_at IS NULL
      ORDER BY created_at
    `
  })
  return rows.map(toCourierStatusExceptionDto)
}
