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
 * Apply the presentation-level bank/courier narrowing shared by every tile.
 * The date window (from/to) is NOT applied here: it belongs to
 * requestsReceived alone (a period count), while the other six tiles are
 * current-state snapshots computed over the full scoped row set (a pending
 * item does not stop being pending because it was received outside the
 * selected period).
 */
function narrowByBankAndCourier(rows: DispatchDbRow[], filters: ReportFilters): DispatchDbRow[] {
  return rows.filter((r) => {
    if (filters.bankCode !== undefined && r.bank_code !== filters.bankCode) return false
    if (filters.courierStatus !== undefined && r.courier_status !== filters.courierStatus) return false
    return true
  })
}

function withinWindow(d: Date | null, filters: ReportFilters): boolean {
  if (d === null) return false
  if (filters.from !== undefined && d.getTime() < new Date(filters.from).getTime()) return false
  if (filters.to !== undefined && d.getTime() > new Date(filters.to).getTime()) return false
  return true
}

/**
 * Compute the seven FR-09 tiles from an already scope-narrowed row set. Each
 * tile is a pure aggregate over `rows` (the caller has already run the
 * mediated, RLS-scoped read), so there is NO global pre-aggregated counter:
 * every value here decomposes per Program by construction (D97).
 */
function computeTiles(rows: DispatchDbRow[], filters: ReportFilters): TileSet {
  const narrowed = narrowByBankAndCourier(rows, filters)

  const requestsReceived = narrowed.filter((r) => withinWindow(r.received_at, filters)).length

  const pendingQr = narrowed.filter(
    (r) => r.pipeline_state === 'RECEIVED' || r.pipeline_state === 'POOLED',
  )
  let oldestAgeDays: number | null = null
  if (pendingQr.length > 0) {
    const oldest = pendingQr.reduce((min, r) => {
      if (r.received_at === null) return min
      return min === null || r.received_at.getTime() < min.getTime() ? r.received_at : min
    }, null as Date | null)
    oldestAgeDays = oldest === null ? null : (Date.now() - oldest.getTime()) / (24 * 60 * 60 * 1000)
  }

  const pendingPrintVendorPickup = narrowed.filter((r) => r.pipeline_state === 'SENT_TO_VENDOR').length

  const dispatchedNotDelivered = narrowed.filter(
    (r) => r.dispatched_at !== null && r.delivery_date === null,
  ).length

  // ACTIVATION-EMPTY (build decision 3): activation_status is null everywhere
  // in live v1 data (no activation write path exists), so this counts
  // everything delivered.
  const deliveredNotActivated = narrowed.filter(
    (r) => r.delivery_date !== null && r.activation_status === null,
  ).length

  const damagedReplacementOpen = narrowed.filter((r) => r.replacement_status === 'RAISED').length

  // ACTIVATION-EMPTY: reads 0 under live v1 data; the predicate itself is the
  // real, general aggregate (correct once an activation write path exists).
  const activatedSuccessfully = narrowed.filter((r) => r.activation_status === 'ACTIVATED').length

  return {
    requestsReceived,
    pendingQrAwaitingBatch: { count: pendingQr.length, oldestAgeDays },
    pendingPrintVendorPickup,
    dispatchedNotDelivered,
    deliveredNotActivated,
    damagedReplacementOpen,
    activatedSuccessfully,
  }
}

/** The tile predicate reused by both readTiles and readTileDrilldown. */
function tilePredicate(tile: TileName): (r: DispatchDbRow) => boolean {
  switch (tile) {
    case 'requestsReceived':
      return () => true // windowing applied separately, see readTileDrilldown
    case 'pendingQrAwaitingBatch':
      return (r) => r.pipeline_state === 'RECEIVED' || r.pipeline_state === 'POOLED'
    case 'pendingPrintVendorPickup':
      return (r) => r.pipeline_state === 'SENT_TO_VENDOR'
    case 'dispatchedNotDelivered':
      return (r) => r.dispatched_at !== null && r.delivery_date === null
    case 'deliveredNotActivated':
      return (r) => r.delivery_date !== null && r.activation_status === null
    case 'damagedReplacementOpen':
      return (r) => r.replacement_status === 'RAISED'
    case 'activatedSuccessfully':
      return (r) => r.activation_status === 'ACTIVATED'
  }
}

/** The seven FR-09 dashboard tile names, keyed identically to TileSet. */
export type TileName = keyof TileSet

/**
 * Reads the scoped modeled layer, computes the seven FR-09 dashboard tiles as
 * per-scope aggregates (D97: no global pre-aggregated counter, so every tile
 * decomposes per Program), and attaches the freshness watermark.
 */
export async function readTiles(
  db: AnalyticsDb,
  scope: ReadScope,
  filters: ReportFilters,
): Promise<{ tiles: TileSet; watermark: Watermark }> {
  const rows = await scopedDispatchRead(db, scope)
  const tiles = computeTiles(rows, filters)
  const watermark = await readFreshness(db)
  return { tiles, watermark }
}

/**
 * Read the filtered dispatch_row list behind a single tile (the drill-down),
 * scoped through the same mediated read as readTiles and carrying the same
 * watermark. requestsReceived is the one tile whose predicate is the from/to
 * window itself (mirroring computeTiles); every other tile reuses its
 * computeTiles predicate verbatim via tilePredicate.
 */
export async function readTileDrilldown(
  db: AnalyticsDb,
  scope: ReadScope,
  tile: TileName,
  filters: ReportFilters,
): Promise<{ rows: ReportRow[]; watermark: Watermark }> {
  const dbRows = await scopedDispatchRead(db, scope)
  const narrowed = narrowByBankAndCourier(dbRows, filters)
  const filtered =
    tile === 'requestsReceived'
      ? narrowed.filter((r) => withinWindow(r.received_at, filters))
      : narrowed.filter(tilePredicate(tile))
  const rows = filtered.map(toReportRow)
  const watermark = await readFreshness(db)
  return { rows, watermark }
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
