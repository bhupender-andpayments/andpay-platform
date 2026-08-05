import { fromUuid, toUuid } from '@andpay/ids'
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

// Phase 3 Task 5b (BRD Annexure D.4): the bank/branch composition-config admin
// list, guard-only exactly like `vendors` above (no D2 authorize, no 6e; the
// read-only DB role scopes visibility -- see the T5b migration's GRANT SELECT
// on bank_composition_config to fulfillment_ops_read). No aggregate here (a
// later guard scans this file): a plain row-list SELECT only, optionally
// filtered to one tenant.
export interface BankCompositionConfigRow {
  id: string
  tenantId: string
  bankCode: string
  branchCode: string
  logoMasterRef: string | null
  logoDerivativeRef: string | null
  brandingParams: unknown
  imageTemplates: unknown
  createdAt: Date
  updatedAt: Date
}

interface BankCompositionConfigDbRow {
  id: string
  tenant_id: string
  bank_code: string
  branch_code: string
  logo_master_ref: string | null
  logo_derivative_ref: string | null
  branding_params: unknown
  image_templates: unknown
  created_at: Date
  updated_at: Date
}

function toBankCompositionConfigDto(r: BankCompositionConfigDbRow): BankCompositionConfigRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    bankCode: r.bank_code,
    branchCode: r.branch_code,
    logoMasterRef: r.logo_master_ref,
    logoDerivativeRef: r.logo_derivative_ref,
    brandingParams: r.branding_params,
    imageTemplates: r.image_templates,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function listBankCompositionConfigs(
  db: FulfillmentDb,
  opts: { tenantWire?: string } = {},
): Promise<BankCompositionConfigRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    if (opts.tenantWire !== undefined) {
      const tenantUuid = toUuid(opts.tenantWire)
      return tx.$queryRaw<BankCompositionConfigDbRow[]>`
        SELECT id::text AS id, tenant_id::text AS tenant_id, bank_code, branch_code,
               logo_master_ref, logo_derivative_ref, branding_params, image_templates, created_at, updated_at
        FROM bank_composition_config
        WHERE tenant_id = ${tenantUuid}::uuid
        ORDER BY bank_code, branch_code
      `
    }
    return tx.$queryRaw<BankCompositionConfigDbRow[]>`
      SELECT id::text AS id, tenant_id::text AS tenant_id, bank_code, branch_code,
             logo_master_ref, logo_derivative_ref, branding_params, image_templates, created_at, updated_at
      FROM bank_composition_config
      ORDER BY bank_code, branch_code
    `
  })
  return rows.map(toBankCompositionConfigDto)
}

// Phase 3 Task 6 (BRD 5.3.2): the batching-parameter admin list, guard-only
// exactly like the reads above (no D2 authorize, no 6e; the read-only DB role
// scopes visibility -- see the T6 migration's GRANT SELECT on batching_config
// to fulfillment_ops_read). No aggregate here (a later guard scans this file):
// a plain row-list SELECT only. The '' scope sentinels are mapped back to a
// discriminated scope + nullable wire ids for the admin UI.
export interface BatchingConfigRow {
  id: string
  scope: 'GLOBAL' | 'TENANT' | 'TENANT_PROGRAM'
  tenantWire: string | null
  programWire: string | null
  minLotSize: number
  maxWaitSeconds: number
  createdAt: Date
  updatedAt: Date
}

interface BatchingConfigDbRow {
  id: string
  tenant_wire: string
  program_wire: string
  min_lot_size: number
  max_wait_seconds: number
  created_at: Date
  updated_at: Date
}

function toBatchingConfigDto(r: BatchingConfigDbRow): BatchingConfigRow {
  const scope: BatchingConfigRow['scope'] =
    r.tenant_wire === '' ? 'GLOBAL' : r.program_wire === '' ? 'TENANT' : 'TENANT_PROGRAM'
  return {
    id: r.id,
    scope,
    tenantWire: r.tenant_wire === '' ? null : r.tenant_wire,
    programWire: r.program_wire === '' ? null : r.program_wire,
    minLotSize: Number(r.min_lot_size),
    maxWaitSeconds: Number(r.max_wait_seconds),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function listBatchingConfigs(db: FulfillmentDb): Promise<BatchingConfigRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    return tx.$queryRaw<BatchingConfigDbRow[]>`
      SELECT id::text AS id, tenant_wire, program_wire, min_lot_size, max_wait_seconds, created_at, updated_at
      FROM batching_config
      ORDER BY tenant_wire, program_wire
    `
  })
  return rows.map(toBatchingConfigDto)
}
