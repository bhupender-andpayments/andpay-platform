import type { AnalyticsDb } from './db.js'
import type { Prisma } from '../generated/client/index.js'
import { enterAnalyticsReadScope, type ReadScope } from './read-context.js'
import { readWatermark, type Watermark } from './watermark.js'

type Tx = Prisma.TransactionClient

// The D99 mediation layer: the ONLY principal that reads the modeled layer
// (dispatch_row). It connects as the single non-owner analytics_read role,
// re-derives scope from the typed ReadScope (never a caller-supplied
// ?program_id/?cross_tenant), and attaches a freshness watermark to every
// result. This file holds the SKELETON of readTiles/readReport plus the shared
// types; Tasks 5 and 6 fill the 7-tile / 6-report query bodies against these
// same types, reused verbatim.

// ---------------------------------------------------------------------------
// Shared types (the real intended shapes; Tasks 5/6/8 reuse them verbatim).
// ---------------------------------------------------------------------------

/**
 * The 7 dashboard tiles (FR-09). Each is a per-scope aggregate over dispatch_row
 * so it decomposes per Program (D97): there is NO global pre-aggregated counter.
 * Task 5 fills the real aggregate for each tile.
 */
export interface TileSet {
  requestsReceived: number
  pendingQrAwaitingBatch: { count: number; oldestAgeDays: number | null }
  pendingPrintVendorPickup: number
  dispatchedNotDelivered: number
  deliveredNotActivated: number
  damagedReplacementOpen: number
  activatedSuccessfully: number
}

/** The 6 reports (FR-10). Task 6 fills each report body. */
export type ReportName =
  | 'soundbox-delivery'
  | 'activation'
  | 'damaged-replacement'
  | 'print-vendor-pendency'
  | 'courier-pendency'
  | 'batching'

/**
 * One serialized report cell. Timestamps are ISO 8601 strings (never Date) so a
 * report row is transport-ready for the edge JSON response and the inline CSV
 * export (Task 6) without further conversion.
 */
export type ReportCell = string | number | boolean | string[] | null

/**
 * One report row. A flexible column map because the six reports have different
 * shapes (per-dispatch worklists AND the per-bank batching aggregate) yet flow
 * through the single readReport return type and toCsv. Task 6 populates the
 * per-report columns.
 */
export type ReportRow = Record<string, ReportCell>

/**
 * Report/dashboard filters. Carries ONLY presentation filters (a date window,
 * an optional bank or courier-status narrowing) computed at query time. It
 * carries NO program/scope field: scope comes solely from the typed ReadScope,
 * so no filter a caller passes can widen or narrow the tenant boundary.
 */
export interface ReportFilters {
  from?: string
  to?: string
  bankCode?: string
  courierStatus?: string
}

// ---------------------------------------------------------------------------
// Internal scoped-query helper.
// ---------------------------------------------------------------------------

// The aliased snake_case shape of the representative modeled read below, typed
// directly against $queryRaw. Timestamps come back as Date and are serialized
// to ISO strings in toReportRow.
interface DispatchDbRow {
  dispatch_id: string
  program_id: string
  bank_code: string
  bank_display: string
  branch: string | null
  merchant_display: string
  device_ids: string[] | null
  awb: string | null
  shpt_id: string | null
  dispatch_date: Date | null
  courier_status: string | null
  delivery_date: Date | null
  activation_status: string | null
  sim_activation_status: string | null
  activation_date: Date | null
  activation_failure_reason: string | null
  pipeline_state: string
  is_replacement: boolean
  original_dispatch_id: string | null
  damage_reason: string | null
  replacement_dispatch_id: string | null
  replacement_status: string | null
  billable_flag: boolean
  received_at: Date | null
  sent_to_vendor_at: Date | null
  dispatched_at: Date | null
}

/**
 * Open ONE transaction, enter the Q5 analytics_read scope, and run a scoped read
 * of the modeled dispatch_row layer. This is the single mediated read path the
 * tile/report bodies (Tasks 5/6) build on. The own scope also carries the
 * belt-and-suspenders application predicate WHERE program_id = ANY(...); the RLS
 * policy is the actual backstop (proven in mediation-scope.test.ts), so
 * correctness does not depend on that predicate. The program-id array is bound
 * through the $queryRaw tagged template, never string-concatenated.
 */
async function scopedDispatchRead(db: AnalyticsDb, scope: ReadScope): Promise<DispatchDbRow[]> {
  return db.$transaction(async (tx: Tx) => {
    await enterAnalyticsReadScope(tx, scope)
    if (scope.kind === 'own') {
      const arrayLiteral = `{${scope.programIds.join(',')}}`
      return tx.$queryRaw<DispatchDbRow[]>`
        SELECT dispatch_id, program_id::text AS program_id, bank_code, bank_display, branch,
               merchant_display, device_ids, awb, shpt_id, dispatch_date, courier_status,
               delivery_date, activation_status, sim_activation_status, activation_date,
               activation_failure_reason, pipeline_state, is_replacement, original_dispatch_id,
               damage_reason, replacement_dispatch_id, replacement_status, billable_flag,
               received_at, sent_to_vendor_at, dispatched_at
        FROM dispatch_row
        WHERE program_id = ANY(${arrayLiteral}::uuid[])`
    }
    // crossTenant: the RLS policy (app.cross_tenant = 'true') authorizes every
    // row, so no application predicate is needed.
    return tx.$queryRaw<DispatchDbRow[]>`
      SELECT dispatch_id, program_id::text AS program_id, bank_code, bank_display, branch,
             merchant_display, device_ids, awb, shpt_id, dispatch_date, courier_status,
             delivery_date, activation_status, sim_activation_status, activation_date,
             activation_failure_reason, pipeline_state, is_replacement, original_dispatch_id,
             damage_reason, replacement_dispatch_id, replacement_status, billable_flag,
             received_at, sent_to_vendor_at, dispatched_at
      FROM dispatch_row`
  })
}

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString()
}

function toReportRow(r: DispatchDbRow): ReportRow {
  return {
    dispatchId: r.dispatch_id,
    programId: r.program_id,
    bankCode: r.bank_code,
    bankDisplay: r.bank_display,
    branch: r.branch,
    merchantDisplay: r.merchant_display,
    deviceIds: r.device_ids ?? [],
    awb: r.awb,
    shptId: r.shpt_id,
    dispatchDate: iso(r.dispatch_date),
    courierStatus: r.courier_status,
    deliveryDate: iso(r.delivery_date),
    activationStatus: r.activation_status,
    simActivationStatus: r.sim_activation_status,
    activationDate: iso(r.activation_date),
    activationFailureReason: r.activation_failure_reason,
    pipelineState: r.pipeline_state,
    isReplacement: r.is_replacement,
    originalDispatchId: r.original_dispatch_id,
    damageReason: r.damage_reason,
    replacementDispatchId: r.replacement_dispatch_id,
    replacementStatus: r.replacement_status,
    billableFlag: r.billable_flag,
    receivedAt: iso(r.received_at),
    sentToVendorAt: iso(r.sent_to_vendor_at),
    dispatchedAt: iso(r.dispatched_at),
  }
}

/**
 * Read the freshness watermark. Deliberately OUTSIDE the analytics_read scope:
 * analytics_watermark is freshness metadata (analytics_read has no grant on it),
 * so it is read on the mediation's base identity in its own short transaction.
 */
async function readFreshness(db: AnalyticsDb): Promise<Watermark> {
  return db.$transaction((tx: Tx) => readWatermark(tx))
}

// ---------------------------------------------------------------------------
// Public mediation API. Every return value includes the watermark.
// ---------------------------------------------------------------------------

/**
 * SKELETON (Task 4). Reads the scoped modeled layer and attaches the watermark.
 * Task 5 replaces the tile body with the seven per-scope aggregates; only
 * requestsReceived is wired here, to a real scoped count, so the skeleton
 * genuinely carries the scope and the watermark rides an aggregate result.
 */
export async function readTiles(
  db: AnalyticsDb,
  scope: ReadScope,
  _filters: ReportFilters,
): Promise<{ tiles: TileSet; watermark: Watermark }> {
  const rows = await scopedDispatchRead(db, scope)
  const tiles: TileSet = {
    requestsReceived: rows.length,
    pendingQrAwaitingBatch: { count: 0, oldestAgeDays: null },
    pendingPrintVendorPickup: 0,
    dispatchedNotDelivered: 0,
    deliveredNotActivated: 0,
    damagedReplacementOpen: 0,
    activatedSuccessfully: 0,
  }
  const watermark = await readFreshness(db)
  return { tiles, watermark }
}

/**
 * SKELETON (Task 4). Reads the scoped modeled layer as a list result and
 * attaches the watermark. Task 6 replaces the body with the six report
 * projections (filters, ageing, and the batching reconstruction) keyed off
 * `report`; the skeleton returns the scoped dispatch rows so the watermark rides
 * a list result too.
 */
export async function readReport(
  db: AnalyticsDb,
  scope: ReadScope,
  _report: ReportName,
  _filters: ReportFilters,
): Promise<{ rows: ReportRow[]; watermark: Watermark }> {
  const dbRows = await scopedDispatchRead(db, scope)
  const rows = dbRows.map(toReportRow)
  const watermark = await readFreshness(db)
  return { rows, watermark }
}
