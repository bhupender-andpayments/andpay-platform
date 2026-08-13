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
  /**
   * Total batches to date (design D8). The other seven tiles count RECORDS; a
   * batch is a different unit entirely, so before this the dashboard could not
   * say how many batches had ever formed.
   *
   * Counted over the SAME narrowed rows as its neighbours, so it decomposes per
   * Program (D97) and honours the bank, courier and date filters identically. A
   * count taken from raw_event instead would have answered a different question
   * from the rest of the dashboard: it could not honour a bank filter, so a
   * filtered view would have shown a batch number that silently contradicted
   * every tile beside it.
   */
  totalBatches: number
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
  dispatch_group: string | null
  source_ref: string | null
  merchant_display: string
  device_ids: string[] | null
  awb: string | null
  shpt_id: string | null
  batch_id: string | null
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
               dispatch_group, source_ref, merchant_display, device_ids, awb, shpt_id, batch_id,
               dispatch_date, courier_status, delivery_date, activation_status,
               sim_activation_status, activation_date, activation_failure_reason, pipeline_state,
               is_replacement, original_dispatch_id, damage_reason, replacement_dispatch_id,
               replacement_status, billable_flag, received_at, sent_to_vendor_at, dispatched_at
        FROM dispatch_row
        WHERE program_id = ANY(${arrayLiteral}::uuid[])`
    }
    // crossTenant: the RLS policy (app.cross_tenant = 'true') authorizes every
    // row, so no application predicate is needed.
    return tx.$queryRaw<DispatchDbRow[]>`
      SELECT dispatch_id, program_id::text AS program_id, bank_code, bank_display, branch,
             dispatch_group, source_ref, merchant_display, device_ids, awb, shpt_id, batch_id,
             dispatch_date, courier_status, delivery_date, activation_status,
             sim_activation_status, activation_date, activation_failure_reason, pipeline_state,
             is_replacement, original_dispatch_id, damage_reason, replacement_dispatch_id,
             replacement_status, billable_flag, received_at, sent_to_vendor_at, dispatched_at
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
    dispatchGroup: r.dispatch_group,
    sourceRef: r.source_ref,
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
// W-5: a SOUNDBOX or a legacy (pre-split, dispatch_group null) row. COLLATERAL
// groups are physical paper: they ship and deliver but never activate, so the
// two activation tiles below must not count them. Every other tile keeps
// counting rows, because they track things physically moving through print
// and courier, and a COLLATERAL row is a real physical thing moving.
const isSoundboxOrLegacy = (r: DispatchDbRow): boolean =>
  r.dispatch_group === null || r.dispatch_group === 'SOUNDBOX'

function computeTiles(rows: DispatchDbRow[], filters: ReportFilters): TileSet {
  const narrowed = narrowByBankAndCourier(rows, filters)

  // requestsReceived counts REQUESTS, not dispatch groups. One bank row can
  // now mint one or two dispatch_row records (a SOUNDBOX group and a
  // COLLATERAL group) sharing the same source_ref, and both are the SAME
  // incoming request. A legacy row (source_ref null) has no group sibling, so
  // it falls back to its own dispatch_id and counts individually, same as
  // today.
  const requestsReceived = new Set(
    narrowed.filter((r) => withinWindow(r.received_at, filters)).map((r) => r.source_ref ?? r.dispatch_id),
  ).size

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
  // everything delivered. W-5: filtered to soundbox-or-legacy, because a
  // COLLATERAL group's lifecycle ends at DELIVERED and it must never appear
  // on the activation worklist.
  const deliveredNotActivated = narrowed.filter(
    (r) => isSoundboxOrLegacy(r) && r.delivery_date !== null && r.activation_status === null,
  ).length

  const damagedReplacementOpen = narrowed.filter((r) => r.replacement_status === 'RAISED').length

  // ACTIVATION-EMPTY: reads 0 under live v1 data; the predicate itself is the
  // real, general aggregate (correct once an activation write path exists).
  // W-5: filtered to soundbox-or-legacy, mirroring deliveredNotActivated.
  const activatedSuccessfully = narrowed.filter(
    (r) => isSoundboxOrLegacy(r) && r.activation_status === 'ACTIVATED',
  ).length

  // DISTINCT, because one batch spans many records: counting rows would report
  // the number of batched RECORDS, which is the mistake this tile exists to
  // correct. Nulls are excluded rather than counted as one anonymous batch: a
  // record with no batch_id has not been batched yet.
  const totalBatches = new Set(
    narrowed.map((r) => r.batch_id).filter((id): id is string => typeof id === 'string' && id !== ''),
  ).size

  return {
    requestsReceived,
    totalBatches,
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
    case 'totalBatches':
      // The TILE counts DISTINCT batches; this drilldown lists the RECORDS in
      // them. That asymmetry is deliberate and unavoidable: every report row is
      // a dispatch record, so there is no batch-shaped row to list. Clicking
      // "12 batches" answers "which records were batched", which is the useful
      // question the record-shaped surface can actually answer.
      return (r) => r.batch_id !== null && r.batch_id !== ''
    case 'pendingQrAwaitingBatch':
      return (r) => r.pipeline_state === 'RECEIVED' || r.pipeline_state === 'POOLED'
    case 'pendingPrintVendorPickup':
      return (r) => r.pipeline_state === 'SENT_TO_VENDOR'
    case 'dispatchedNotDelivered':
      return (r) => r.dispatched_at !== null && r.delivery_date === null
    case 'deliveredNotActivated':
      return (r) => isSoundboxOrLegacy(r) && r.delivery_date !== null && r.activation_status === null
    case 'damagedReplacementOpen':
      return (r) => r.replacement_status === 'RAISED'
    case 'activatedSuccessfully':
      return (r) => isSoundboxOrLegacy(r) && r.activation_status === 'ACTIVATED'
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
  // Watermark read FIRST (check 4): captured at T1, before the scoped data
  // read at T2 >= T1, so a concurrent ingest between T1 and T2 is reflected in
  // the data but not yet in the watermark. That makes the watermark a true
  // floor (asOf never overstates what the data actually contains), never the
  // reverse.
  const watermark = await readFreshness(db)
  const rows = await scopedDispatchRead(db, scope)
  const tiles = computeTiles(rows, filters)
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
  // Watermark read FIRST (check 4): see readTiles for the floor-property
  // rationale. The reorder applies identically here.
  const watermark = await readFreshness(db)
  const dbRows = await scopedDispatchRead(db, scope)
  const narrowed = narrowByBankAndCourier(dbRows, filters)
  const filtered =
    tile === 'requestsReceived'
      ? narrowed.filter((r) => withinWindow(r.received_at, filters))
      : narrowed.filter(tilePredicate(tile))
  const rows = filtered.map(toReportRow)
  return { rows, watermark }
}

const REPORT_DAY_MS = 24 * 60 * 60 * 1000

/** Age in days between now and a timestamp (fractional; not rounded). */
function ageDays(d: Date): number {
  return (Date.now() - d.getTime()) / REPORT_DAY_MS
}

/**
 * The same age, rounded for REPORTING (G-7).
 *
 * Found in a real browser: the Batching report rendered "Oldest Record Age
 * Days" as `3.0118497337962964`, and the CSV export carried the identical raw
 * float. Sixteen significant figures is not a measurement anyone asked for; the
 * useful precision for "how old is the oldest thing in this pool" is a tenth of
 * a day.
 *
 * Rounded HERE, at the point the number lands on a report row, and NOT inside
 * `ageDays`: `ageingBucket` compares that value against 1, 3 and 7, so rounding
 * at the source would move bucket boundaries and silently reclassify rows. This
 * separation is the whole point, so the two must not be merged.
 */
function reportedAgeDays(d: Date): number {
  return Math.round(ageDays(d) * 10) / 10
}

/**
 * Ageing bucket labels for the two pendency reports, computed at query time
 * from the relevant timestamp (sent_to_vendor_at / dispatched_at). Buckets are
 * a presentation choice, not a spec-mandated boundary; kept simple and stable.
 */
function ageingBucket(d: Date): string {
  const days = ageDays(d)
  if (days < 1) return '0-1d'
  if (days < 3) return '1-3d'
  if (days < 7) return '3-7d'
  return '7d+'
}

/**
 * Report-level date-window filter. Unlike the tile-level withinWindow (which
 * always excludes a null timestamp), an absent from/to filter must not exclude
 * rows whose relevant date column happens to be null: the window only bites
 * when the caller actually narrows by date.
 */
function withinReportWindow(d: Date | null, filters: ReportFilters): boolean {
  if (filters.from === undefined && filters.to === undefined) return true
  if (d === null) return false
  if (filters.from !== undefined && d.getTime() < new Date(filters.from).getTime()) return false
  if (filters.to !== undefined && d.getTime() > new Date(filters.to).getTime()) return false
  return true
}

// ---------------------------------------------------------------------------
// Per-report row shapes (FR-10). Each report projects only the columns the
// brief names for it; the batching report has an entirely different (per-bank
// aggregate) shape with NO dispatchId at all.
// ---------------------------------------------------------------------------

// G-SHPT: shptId is emitted AS-IS, no fromUuid wrap. dispatch_row.shpt_id is
// already a wire `shpt_` string end to end (project.ts copies the folded
// fact's shptId verbatim, and every producer of that fact -- courier-status.ts,
// ops.ts's overrideTerminal -- emits it in wire form already; see
// G_SHPT_backend_spec.md section 2b for the full trace). Wrapping it in
// fromUuid('shpt', ...) here would double-encode a value that is not a raw
// uuid and would throw.
function soundboxDeliveryRow(r: DispatchDbRow): ReportRow {
  return {
    dispatchId: r.dispatch_id,
    programId: r.program_id,
    bankCode: r.bank_code,
    merchantDisplay: r.merchant_display,
    awb: r.awb,
    shptId: r.shpt_id,
    dispatchDate: iso(r.dispatch_date),
    courierStatus: r.courier_status,
    deliveryDate: iso(r.delivery_date),
  }
}

// The FR-07 Phase-1 delivered-not-activated worklist. Activation columns
// render null under ACTIVATION-EMPTY (no activation write path exists yet in
// live v1 data); the predicate itself is the real, general worklist
// definition (correct once an activation write path exists). deviceIds
// mirrors the same generic device_ids exposure toReportRow already uses
// (raw hardware serials, no encode/decode; @andpay/ids has no registered
// device id kind), added per the BRD FR-10 Activation Report column set.
function activationRow(r: DispatchDbRow): ReportRow {
  return {
    dispatchId: r.dispatch_id,
    programId: r.program_id,
    bankCode: r.bank_code,
    merchantDisplay: r.merchant_display,
    deviceIds: r.device_ids ?? [],
    deliveryDate: iso(r.delivery_date),
    activationStatus: r.activation_status,
    simActivationStatus: r.sim_activation_status,
    activationDate: iso(r.activation_date),
    activationFailureReason: r.activation_failure_reason,
  }
}

function damagedReplacementRow(r: DispatchDbRow): ReportRow {
  return {
    dispatchId: r.dispatch_id,
    programId: r.program_id,
    bankCode: r.bank_code,
    isReplacement: r.is_replacement,
    originalDispatchId: r.original_dispatch_id,
    damageReason: r.damage_reason,
    replacementDispatchId: r.replacement_dispatch_id,
    replacementStatus: r.replacement_status,
  }
}

function printVendorPendencyRow(r: DispatchDbRow): ReportRow {
  return {
    dispatchId: r.dispatch_id,
    programId: r.program_id,
    bankCode: r.bank_code,
    merchantDisplay: r.merchant_display,
    sentToVendorAt: iso(r.sent_to_vendor_at),
    ageingDays: r.sent_to_vendor_at === null ? null : reportedAgeDays(r.sent_to_vendor_at),
    ageingBucket: r.sent_to_vendor_at === null ? null : ageingBucket(r.sent_to_vendor_at),
  }
}

function courierPendencyRow(r: DispatchDbRow): ReportRow {
  return {
    dispatchId: r.dispatch_id,
    programId: r.program_id,
    bankCode: r.bank_code,
    awb: r.awb,
    courierStatus: r.courier_status,
    dispatchedAt: iso(r.dispatched_at),
    ageingDays: r.dispatched_at === null ? null : reportedAgeDays(r.dispatched_at),
    ageingBucket: r.dispatched_at === null ? null : ageingBucket(r.dispatched_at),
  }
}

/**
 * The Batching report (rule c, ratified): v1 ships pool-size-per-bank and
 * oldest-record-age ONLY; the projected-trigger-date column is DEFERRED (a
 * follow-up once Fulfillment emits its batching parameters as a fact under
 * FR-11), so this row shape has NO projectedTriggerDate field.
 *
 * Reconstructed from dispatch_row alone (NOT raw_event: analytics_read has no
 * grant there, and reading raw_event under this role would fail closed with
 * permission denied). The received-not-batched set is exactly the dispatch_row
 * rows whose pipeline_state is 'RECEIVED' (received, not yet advanced to
 * POOLED/BATCHED/etc). Grouped per bank_code: pool-size = row count,
 * oldest-record-age = now() - min(received_at).
 */
function computeBatchingReport(rows: DispatchDbRow[], filters: ReportFilters): ReportRow[] {
  const received = rows.filter(
    (r) => r.pipeline_state === 'RECEIVED' && withinReportWindow(r.received_at, filters),
  )
  const byBank = new Map<string, DispatchDbRow[]>()
  for (const r of received) {
    const list = byBank.get(r.bank_code)
    if (list) {
      list.push(r)
    } else {
      byBank.set(r.bank_code, [r])
    }
  }
  const out: ReportRow[] = []
  for (const [bankCode, list] of byBank) {
    const oldest = list.reduce<Date | null>(
      (min, r) => (r.received_at !== null && (min === null || r.received_at.getTime() < min.getTime()) ? r.received_at : min),
      null,
    )
    out.push({
      bankCode,
      poolSize: list.length,
      oldestRecordAgeDays: oldest === null ? null : reportedAgeDays(oldest),
    })
  }
  return out
}

function computeReport(report: ReportName, rows: DispatchDbRow[], filters: ReportFilters): ReportRow[] {
  switch (report) {
    case 'soundbox-delivery':
      return rows
        .filter((r) => r.dispatched_at !== null && withinReportWindow(r.dispatch_date, filters))
        .map(soundboxDeliveryRow)
    case 'activation':
      // W-5: filtered to soundbox-or-legacy, mirroring the deliveredNotActivated
      // tile. A COLLATERAL group's lifecycle ends at DELIVERED and must never
      // appear on the activation worklist.
      return rows
        .filter(
          (r) =>
            isSoundboxOrLegacy(r) &&
            r.delivery_date !== null &&
            r.activation_status === null &&
            withinReportWindow(r.delivery_date, filters),
        )
        .map(activationRow)
    case 'damaged-replacement':
      return rows
        .filter(
          (r) => (r.is_replacement || r.replacement_status !== null) && withinReportWindow(r.received_at, filters),
        )
        .map(damagedReplacementRow)
    case 'print-vendor-pendency':
      return rows
        .filter(
          (r) =>
            r.pipeline_state === 'SENT_TO_VENDOR' &&
            r.dispatched_at === null &&
            withinReportWindow(r.sent_to_vendor_at, filters),
        )
        .map(printVendorPendencyRow)
    case 'courier-pendency':
      return rows
        .filter(
          (r) => r.dispatched_at !== null && r.delivery_date === null && withinReportWindow(r.dispatched_at, filters),
        )
        .map(courierPendencyRow)
    case 'batching':
      return computeBatchingReport(rows, filters)
  }
}

/**
 * Reads the scoped modeled layer, applies the shared bank/courier narrowing
 * plus the per-report date window and predicate (FR-10), and attaches the
 * freshness watermark. All six reports run under the same mediated scope
 * (`enterAnalyticsReadScope` via `scopedDispatchRead`) and the same frozen
 * ReportRow/ReportFilters types as the tiles; none diverges to a SQL
 * aggregate (that optimization is a recorded service-wide decision for the
 * final review).
 */
export async function readReport(
  db: AnalyticsDb,
  scope: ReadScope,
  report: ReportName,
  filters: ReportFilters,
): Promise<{ rows: ReportRow[]; watermark: Watermark }> {
  // Watermark read FIRST (check 4): see readTiles for the floor-property
  // rationale. The reorder applies identically here.
  const watermark = await readFreshness(db)
  const dbRows = await scopedDispatchRead(db, scope)
  // The batching report has NO courier dimension (it is built from
  // pipeline_state='RECEIVED' rows, whose courier_status is always null), so a
  // caller-supplied ?status= must not narrow it: doing so reachably zeroes the
  // whole report. The bank filter still legitimately applies (batching groups
  // per bank), so only courierStatus is stripped here, batching only.
  const narrowFilters: ReportFilters =
    report === 'batching' ? { ...filters, courierStatus: undefined } : filters
  const narrowed = narrowByBankAndCourier(dbRows, narrowFilters)
  const rows = computeReport(report, narrowed, filters)
  return { rows, watermark }
}

/** The single-dispatch-row activation-gate signal (D-H.1, Phase 5 Task 2). */
export interface DispatchActivationStatus {
  deliveryDate: string | null
  activationStatus: string | null
  activationDate: string | null
  /**
   * W-5: which physical consignment this dispatch_row is. Null for a legacy
   * (pre-split) row. The ops-edge activate route 409s a COLLATERAL group
   * before it ever reaches the TMS write: paper does not activate.
   */
  dispatchGroup: string | null
}

/**
 * Phase 5 Task 2 (D-H.1): a single-row-by-id read of the delivery/activation
 * signal for one dispatch, for the class-3 ops "mark activated" DELIVERED
 * gate. This is a LOCAL analytics projection read (no cross-context DB read,
 * C4): ops-edge already holds analyticsDb and calls this in-process, exactly
 * like readTiles/readReport above. Always enters the crossTenant scope
 * (ops-edge never constructs an 'own' scope, guardrail G1), so this returns
 * the row regardless of program.
 *
 * The gate predicate is `deliveryDate IS NOT NULL` and never a `pipelineState`
 * check. That was originally because pipelineState rolled up past 'DELIVERED'
 * to 'ACTIVATED' once the activation fact folded, so an equality check would
 * have wrongly rejected a second activation attempt after the first succeeded.
 * As of D-16 (T4.3) pipelineState no longer carries activation at all, and the
 * reason has become the stronger one: activation is a different axis and this
 * column cannot speak for it. deliveryDate is set once when DELIVERED is folded
 * (project.ts) and never cleared afterward, so the caller compares it directly;
 * this function does no gating itself, it only surfaces the signal.
 *
 * Returns null when no dispatch_row exists yet for this id (the assignment
 * has not yet been projected, or was never dispatched at all).
 */
export async function readDispatchActivationStatus(
  db: AnalyticsDb,
  dispatchId: string,
): Promise<DispatchActivationStatus | null> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await enterAnalyticsReadScope(tx, { kind: 'crossTenant' })
    return tx.$queryRaw<
      {
        delivery_date: Date | null
        activation_status: string | null
        activation_date: Date | null
        dispatch_group: string | null
      }[]
    >`
      SELECT delivery_date, activation_status, activation_date, dispatch_group FROM dispatch_row WHERE dispatch_id = ${dispatchId}
    `
  })
  if (rows.length === 0) return null
  const r = rows[0]!
  return {
    deliveryDate: iso(r.delivery_date),
    activationStatus: r.activation_status,
    activationDate: iso(r.activation_date),
    dispatchGroup: r.dispatch_group,
  }
}

/**
 * The batch-journey rollup (workflow workspace, 2026-08-11 ruling). ONE batch's
 * position in the Bank Request to Activation lifecycle, for stages 6 to 8 of the
 * ops workflow workspace.
 *
 * Exists because no other read can answer it. GET /ops/dispatches returns shpt_
 * ids with no batch link at all (the fulfillment context's own ops-read module),
 * and batch_id, courier_status and activation_status sit together only here.
 *
 * That reference is deliberately NOT written as a path. The C4 guard in
 * test/analytics_rail.test.ts is a substring scan for `services/<ctx>/`, so citing
 * another context's source path here fails it even from inside a comment, and it
 * was failing exactly that way from this file's first commit. Naming the context
 * rather than its file layout is also the more honest reference: a line number in
 * another context's source is a coupling that drifts silently.
 *
 * batch_id holds the WIRE btch_ string, not a uuid (project.ts folds it straight
 * off the batch fact, whose producer emits btchWire), so it is matched directly
 * and there is no toUuid and no invalid-id path.
 *
 * Returns null for a batch with no rows, mirroring readDispatchActivationStatus,
 * so the caller can tell "no such batch" from "a batch at stage zero".
 */
export interface BatchJourneyView {
  batchId: string
  /**
   * CUMULATIVE stage counts off PIPELINE_RANK: a DELIVERED row has also been
   * sent to vendor and dispatched, so it is counted in all three. This is what
   * lets the rail mark a stage complete only when nobody is still behind it.
   */
  counts: {
    total: number
    /**
     * The rows that CAN reach DELIVERED and CAN be activated: the
     * isSoundboxOrLegacy subset, which is a SUBSET of `total` and is the
     * denominator stages 7 and 8 of the ops workflow rail measure against.
     *
     * It exists because `delivered` and `total` are at different grains.
     * Delivery is tracked on the DEVICE parcel, so a COLLATERAL group (sticker
     * plus standee) ships and delivers under its own AWB but never carries a
     * merchant to DELIVERED, and never activates at all. `total` counts every
     * row, collateral included. Observed live on 2026-08-11: a batch of 5 bank
     * requests was 10 rows, all 10 shipments reached DELIVERED in
     * fulfillment.shpt, and this read answered total 10 with delivered 5. So
     * `delivered === total` was unreachable for any batch carrying collateral,
     * which is every real batch.
     *
     * ONE FIELD FOR BOTH STAGES, deliberately. isSoundboxOrLegacy is the same
     * predicate for delivery and for activation (it mirrors the activate route's
     * own group gate), so a separate deliverable count and activatable count
     * would always hold the same number and would only give the two a way to
     * drift apart.
     *
     * The earlier counts keep `total` as their denominator, and that is correct
     * rather than an oversight: a COLLATERAL row really is printed, really is
     * sent to the vendor and really is dispatched, so sentToVendor and
     * dispatched genuinely apply to every row.
     */
    deliverableAndActivatable: number
    sentToVendor: number
    dispatched: number
    delivered: number
    activated: number
  }
  /**
   * The courier fan-out. A batch's records are at different courier stages at
   * once, so one status for the batch would be a fiction. `exception` is any
   * terminal-but-not-delivered status (RETURNED, FAILED), which is the only
   * part of this the operator must act on. Those two strings are the writer's
   * own vocabulary (courier-status.ts KNOWN_STATUS); do not spell either of
   * them 'RTO' here, which is prose for RETURNED and matches no row.
   */
  courier: {
    pickedUp: number
    inTransit: number
    outForDelivery: number
    delivered: number
    exception: number
  }
  /**
   * `simActivated` is ALWAYS null: sim_activation_status has no write path
   * anywhere in the system, so any number here would be invented. Null is what
   * makes the portal render "Not available yet" instead of a truthful-looking
   * zero.
   */
  activation: {
    awaiting: number
    activated: number
    failed: number
    simActivated: null
  }
  /**
   * When this batch was FIRST sent to the print vendor: the earliest non-null
   * sent_to_vendor_at across its rows, or null if none carries one yet.
   *
   * EARLIEST, not latest, because the question the Print stage asks is "when did
   * this batch go out", and a batch's rows are written in one pass but their
   * timestamps are per row. The earliest is the moment the vendor could first have
   * started; a later one would understate how long the vendor has had it.
   *
   * Null is a real answer and must render as an absence, not as a zero or as a
   * substitute: `batch.createdAt` is when the batch FORMED, which is earlier and a
   * different fact, and `batch.updatedAt` moves for unrelated reasons.
   */
  sentToVendorAt: string | null
  /** The stage-8 worklist: delivered, not yet activated. PII-free. */
  awaitingActivation: {
    dispatchId: string
    merchantDisplay: string
    awb: string | null
    deliveryDate: string | null
  }[]
  watermark: Watermark
}

// The FULFILLMENT axis, mirroring project.ts's PIPELINE_RANK, which is the
// column this reads. ACTIVATED left both of them together (D-16, T4.3): one
// ordinal cannot answer two independent questions, and while it tried, an
// activation that arrived before its delivery fact made the row read as
// delivered here while its delivery_date said otherwise.
const JOURNEY_RANK: Record<string, number> = {
  RECEIVED: 1,
  BATCHED: 2,
  SENT_TO_VENDOR: 3,
  DISPATCHED: 4,
  DELIVERED: 5,
}

function atLeast(state: string, floor: string): boolean {
  return (JOURNEY_RANK[state] ?? 0) >= (JOURNEY_RANK[floor] ?? 0)
}

// The activation axis, read from its own column. A free function rather than an
// inline comparison so that stage 8 and the awaiting-activation worklist below
// cannot drift apart: they are the two halves of one question.
const isActivated = (r: DispatchDbRow): boolean => r.activation_status === 'ACTIVATED'

export async function readBatchJourney(
  db: AnalyticsDb,
  scope: ReadScope,
  batchId: string,
): Promise<BatchJourneyView | null> {
  // Watermark FIRST (check 4), same floor-property rationale as readTiles: read
  // after the data and asOf could overstate what the rows reflect.
  const watermark = await readFreshness(db)
  const all = await scopedDispatchRead(db, scope)
  const rows = all.filter((r) => r.batch_id === batchId)
  if (rows.length === 0) return null

  const counts = {
    total: rows.length,
    // The stage 7 and 8 denominator, at the grain those two stages actually
    // measure. Same predicate the two activation tiles and the awaiting worklist
    // below already apply, called rather than re-expressed: an earlier change in
    // this feature reproduced one of its two gates by hand and shipped the other
    // one missing.
    deliverableAndActivatable: rows.filter(isSoundboxOrLegacy).length,
    sentToVendor: rows.filter((r) => atLeast(r.pipeline_state, 'SENT_TO_VENDOR')).length,
    dispatched: rows.filter((r) => atLeast(r.pipeline_state, 'DISPATCHED')).length,
    delivered: rows.filter((r) => atLeast(r.pipeline_state, 'DELIVERED')).length,
    // STAGE 8 IS PARALLEL TO STAGE 7, not after it (D-16, T4.3). It is counted
    // off the activation axis, so a record the CWD activated while the parcel
    // was still in transit is counted here and is NOT counted as delivered,
    // which is the truth about that record rather than a rollup's guess.
    activated: rows.filter(isActivated).length,
  }

  const courier = {
    pickedUp: rows.filter((r) => r.courier_status === 'PICKED_UP').length,
    inTransit: rows.filter((r) => r.courier_status === 'IN_TRANSIT').length,
    outForDelivery: rows.filter((r) => r.courier_status === 'OUT_FOR_DELIVERY').length,
    delivered: rows.filter((r) => r.courier_status === 'DELIVERED').length,
    // RETURNED, not 'RTO' (fixed 12 Aug 2026, PLAN.md T0b.2). courier_status is
    // written verbatim from shpt.status, whose vocabulary is
    // fulfillment/src/courier-status.ts's KNOWN_STATUS: the ladder plus FAILED
    // and RETURNED. NOTHING has ever written 'RTO', so this filter matched no
    // row and a returned parcel appeared in NONE of the five courier counts
    // below, neither delivered nor in transit nor an exception. It read as a
    // vanished shipment on the journey view, and the bug survived because the
    // test fixture inserted the wrong value directly (batch-journey.test.ts)
    // instead of going through a writer.
    exception: rows.filter((r) => r.courier_status === 'RETURNED' || r.courier_status === 'FAILED').length,
  }

  // The activate route enforces TWO gates (ops.controller.ts): delivery_date
  // not null, AND dispatch_group is not COLLATERAL (W-5, "paper does not
  // activate"). Both are mirrored here via isSoundboxOrLegacy, the same
  // predicate the deliveredNotActivated/activatedSuccessfully tiles already
  // use, so a delivered COLLATERAL row (physical paper that ships and
  // delivers but never activates) never reaches this worklist. Offering a
  // record the write would 409 is worse than omitting it.
  const awaiting = rows.filter((r) => isSoundboxOrLegacy(r) && r.delivery_date !== null && !isActivated(r))

  const activation = {
    awaiting: awaiting.length,
    activated: counts.activated,
    failed: rows.filter((r) => r.activation_failure_reason !== null).length,
    simActivated: null,
  } as const

  // Reduced over the rows already fetched, not re-queried: sent_to_vendor_at is
  // ALREADY in DispatchDbRow and ALREADY selected by both scopedDispatchRead
  // queries, so this costs nothing and adds no SQL.
  const sentAt = rows
    .map((r) => r.sent_to_vendor_at)
    .filter((d): d is Date => d !== null)
    .reduce<Date | null>((min, d) => (min === null || d < min ? d : min), null)

  return {
    batchId,
    counts,
    courier,
    activation,
    sentToVendorAt: iso(sentAt),
    awaitingActivation: awaiting.map((r) => ({
      dispatchId: r.dispatch_id,
      merchantDisplay: r.merchant_display,
      awb: r.awb,
      deliveryDate: iso(r.delivery_date),
    })),
    watermark,
  }
}
