import {
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import {
  readTiles,
  readReport,
  readTileDrilldown,
  readBatchJourney,
  readBatchJourneySummaries,
  readDispatchDetail,
  toCsv,
  activationSheetXlsx,
  type ReadScope,
  type ReportName,
  type ReportRow,
  type ReportFilters,
  type TileName,
} from '@andpay/analytics-service'
import { readShipmentTrailOps, readUnitSimsBySerialsOps } from '@andpay/fulfillment-service'
import { readActivationTrailOps } from '@andpay/tms-service'
import { OpsEdgeGuard } from './guard.js'
import { EDGE_DEPS, type OpsEdgeDeps } from './deps.js'
import { emitOpsAnalyticsRead, emitOpsAnalyticsCrossTenant } from './audit.js'
import { requireUnrestrictedRead } from './read-restriction.js'
import type { EdgeRequest } from './request.js'

// The minimal response shape this controller writes to (see the tenant edge's
// ReportsController): the CSV path sets the content-type, the JSON path leaves
// Nest's default. @Res is used with { passthrough: true } so Nest still
// serializes the returned value.
interface EdgeResponse {
  setHeader(name: string, value: string): void
}

// A SECOND response shape, for the one route here that writes a BINARY body
// (the activation-sheet xlsx below), and why it is a second interface rather
// than a widening of the first.
//
// This repo does not depend on @types/express, which is why both of these are
// hand-written structural types (the vendor-edge PullController and
// OpsReadController carry the same pair for the same reason). A binary body
// needs status() and send(Buffer) and must NOT go through
// @Res({ passthrough: true }): with passthrough Nest still tries to serialize
// the handler's return value onto a response the handler already ended, which
// is how a download turns into a half-written body or a double-send warning.
// Widening EdgeResponse instead would hand every JSON and CSV route here a
// send() and a status() they must never call, and the compiler would stop being
// the thing that says so.
interface EdgeBinaryResponse {
  setHeader(name: string, value: string): void
  status(code: number): EdgeBinaryResponse
  send(body: Buffer): void
}

const REPORT_NAMES: ReadonlySet<string> = new Set<ReportName>([
  'soundbox-delivery',
  'activation',
  'damaged-replacement',
  'print-vendor-pendency',
  'courier-pendency',
  'batching',
])

const TILE_NAMES: ReadonlySet<string> = new Set<TileName>([
  'requestsReceived',
  'pendingQrAwaitingBatch',
  'pendingPrintVendorPickup',
  'dispatchedNotDelivered',
  'deliveredNotActivated',
  'damagedReplacementOpen',
  'activatedSuccessfully',
])

// Map the request's presentation query params to ReportFilters. ONLY the
// date-window / bank / courier-status narrowing is read; ?program_id and
// ?cross_tenant are deliberately never consulted (D99). The ?bank= narrowing is
// a legitimate presentation filter, distinct from a scope-spoofing ?program_id=.
function toFilters(q: Record<string, string | undefined>): ReportFilters {
  const filters: ReportFilters = {}
  if (typeof q['from'] === 'string') filters.from = q['from']
  if (typeof q['to'] === 'string') filters.to = q['to']
  if (typeof q['bank'] === 'string') filters.bankCode = q['bank']
  if (typeof q['status'] === 'string') filters.courierStatus = q['status']
  return filters
}

// The class-3 ops reporting edge (spec 11 task 8, ADDITIVE). @UseGuards is
// CLASS-level (OpsEdgeGuard already rejects any claim whose class is not 3), so
// this edge is class-3 by construction. A class-3 claim carries an EMPTY scope
// (no pids) by design, so every route re-derives the actor from the VERIFIED
// claim (req.claim.sub, D99) and builds a { kind: 'crossTenant' } ReadScope:
// only a class-3 edge can ever construct crossTenant (guardrail G1). Each read
// emits BOTH the per-read analytics 6e (cls 3) AND the D99 cross-tenant-access
// entry (guardrail G3) into the ANALYTICS outbox, BEFORE the mediated read,
// then fans to the same mediation API the tenant edge uses. IDs-and-enums only
// on the 6e (S7); the report data rides the HTTP response body ONLY.
@Controller('ops/reports')
@UseGuards(OpsEdgeGuard)
export class ReportsController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: OpsEdgeDeps) {}

  // Server-side actor re-derivation (D99). A class-3 claim is authorized to the
  // cross-tenant union by construction (no per-program scope exists to check),
  // so this always ALLOWs, emitting the per-read 6e AND the distinct
  // cross-tenant-access entry before any DB access.
  private async authorize(req: EdgeRequest, operation: string): Promise<void> {
    const principalId = req.claim.sub
    await emitOpsAnalyticsRead(this.deps.analyticsDb, {
      principalId,
      operation,
      decision: 'ALLOW',
      resourceIds: [],
      traceId: req.traceId,
    })
    await emitOpsAnalyticsCrossTenant(this.deps.analyticsDb, {
      principalId,
      operation,
      traceId: req.traceId,
    })
  }

  // R-5 (16 Aug 2026, docs/plan/UAT_DECISIONS_2026-08-16.md): D-19 asks for
  // the ICCID on the activation report, and the SIM deliberately never
  // reaches analytics (S7, migration 20260803120000). So the EDGE merges it
  // here from the fulfillment ops read, whose column grant carries sim_no
  // (20260812150000), and the analytics row shape stays SIM-free. simNos is
  // positional against deviceIds; a device with no captured SIM renders ''
  // rather than shifting its neighbours. The corpus confirmation of the
  // underlying grant is STILL OWED (UAT_DECISIONS item 12); this route rides
  // that grant, it does not widen it.
  //
  // Extracted from report() into a method the moment a SECOND caller appeared
  // (the batch-scoped xlsx download). Two inline copies of a positional merge
  // is exactly how the two doors would drift, and the drift would be silent:
  // an off-by-one here does not fail, it hands the CWD the wrong subscriber for
  // a device and nothing downstream can detect the mispairing. One merge, one
  // blanking rule, one grant.
  //
  // ONE round trip for the whole page, not one per row: the serials are
  // collected into a Set across every result row first, so a 500-row report is
  // still a single fulfillment read.
  private async mergeActivationSims(rows: ReportRow[]): Promise<ReportRow[]> {
    const serials = new Set<string>()
    for (const row of rows) {
      const ids = row['deviceIds']
      if (Array.isArray(ids)) for (const id of ids) serials.add(id)
    }
    const sims = await readUnitSimsBySerialsOps(this.deps.fulfillmentDb, [...serials])
    return rows.map((row) => {
      const ids = Array.isArray(row['deviceIds']) ? (row['deviceIds'] as string[]) : []
      return { ...row, simNos: ids.map((id) => sims.get(id) ?? '') }
    })
  }

  @Get('tiles')
  @HttpCode(200)
  async tiles(@Req() req: EdgeRequest, @Query() q: Record<string, string | undefined>): Promise<unknown> {
    await this.authorize(req, 'analytics:read-tiles')
    const scope: ReadScope = { kind: 'crossTenant' }
    return readTiles(this.deps.analyticsDb, scope, toFilters(q))
  }

  @Get('tiles/:tile')
  @HttpCode(200)
  async tileDrilldown(
    @Req() req: EdgeRequest,
    @Param('tile') tile: string,
    @Query() q: Record<string, string | undefined>,
    @Res({ passthrough: true }) res: EdgeResponse,
  ): Promise<unknown> {
    if (!TILE_NAMES.has(tile)) throw new NotFoundException()
    // D-29/DP-8: the CSV EXPORT of a drill-down is denied to the restricted
    // customer_support role; the JSON view of the same drill-down stays open.
    // Checked BEFORE this.authorize so a denied export leaves no ALLOW read 6e
    // on the chain for a read that never happened (the same ordering the
    // mutation routes use for their pre-gate validation).
    if (q['format'] === 'csv') requireUnrestrictedRead(req.claim)
    await this.authorize(req, 'analytics:read-tile-drilldown')
    const scope: ReadScope = { kind: 'crossTenant' }
    const result = await readTileDrilldown(this.deps.analyticsDb, scope, tile as TileName, toFilters(q))
    res.setHeader('x-analytics-watermark', result.watermark.asOf ?? 'none')
    if (q['format'] === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      return toCsv(result.rows)
    }
    return result
  }

  // GET /ops/reports/batch-journey (workflow workspace, batch worklist page):
  // every batch's rollup in ONE call, the bulk sibling of batch-journey/:btchId
  // just below. DECLARED BEFORE the generic @Get(':name') at the bottom of
  // this class for the same reason every other specific path here is: Nest
  // registers routes in declaration order and the first match wins, so a
  // specific path declared after :name would be swallowed by it.
  //
  // Same posture as the per-batch route: analytics-mediated CROSS-TENANT read,
  // so guardrail G3 binds it to emit both the per-read 6e and the D99
  // cross-tenant-access entry, reusing the existing 'analytics:read-report'
  // operation (no new permission minted, same Pattern B the activation xlsx
  // route above documents). JSON only, so no requireUnrestrictedRead: that
  // gate exists for binary downloads and CSV exports (D-29/DP-8), and this
  // route is neither.
  @Get('batch-journey')
  @HttpCode(200)
  async batchJourneySummaries(
    @Req() req: EdgeRequest,
    @Res({ passthrough: true }) res: EdgeResponse,
  ): Promise<unknown> {
    await this.authorize(req, 'analytics:read-report')
    const result = await readBatchJourneySummaries(this.deps.analyticsDb)
    res.setHeader('x-analytics-watermark', result.watermark.asOf ?? 'none')
    return result
  }

  // GET /ops/reports/batch-journey/:btchId (workflow workspace, 2026-08-11
  // ruling): ONE batch's position in the Bank Request to Activation lifecycle.
  //
  // It lives HERE and not on OpsReadController's /ops/batches/:btchId/journey,
  // even though that URL reads better. This is an analytics-mediated CROSS-TENANT
  // read, so guardrail G3 binds it to emit both the per-read analytics 6e and the
  // D99 cross-tenant-access entry, which is this controller's whole posture.
  // OpsReadController is pinned by object-spine-http.test.ts to emit ZERO audit
  // records ("reads are NOT mutations", check 3), so hosting it there would have
  // silently broken that guarantee to buy a prettier path.
  //
  // The btchId is a WIRE btch_ string and is matched directly: analytics
  // dispatch_row.batch_id holds the wire id, not a uuid, so there is no toUuid
  // and therefore no invalid-id 400 on this route.
  //
  // 404 on a batch with no rows, mirroring OpsReadController's batchDetail, so
  // the caller can tell "no such batch" from "a batch at stage zero".
  @Get('batch-journey/:btchId')
  @HttpCode(200)
  async batchJourney(
    @Req() req: EdgeRequest,
    @Param('btchId') btchId: string,
    @Res({ passthrough: true }) res: EdgeResponse,
  ): Promise<unknown> {
    await this.authorize(req, 'analytics:read-batch-journey')
    const scope: ReadScope = { kind: 'crossTenant' }
    const result = await readBatchJourney(this.deps.analyticsDb, scope, btchId)
    if (result === null) throw new NotFoundException()
    res.setHeader('x-analytics-watermark', result.watermark.asOf ?? 'none')
    return result
  }

  // GET /ops/reports/dispatch/:asgnId (D-16, T4.5): ONE Dispatch ID's two
  // branches, side by side, with the full history under each.
  //
  // THE COMPOSITION HAPPENS HERE and could not happen anywhere else. The branch
  // STATE is analytics, which is where the two axes already meet. The two TRAILS
  // belong to the contexts that own them: shpt_status_event to fulfillment,
  // assignment_activation_event to TMS. No service reads another's tables and
  // nothing is joined (C4, T1, T7); the edge fans out to three reads and puts
  // the answer together, which is the same pattern the batch-journey view and
  // the merchant-name resolution already use.
  //
  // It lives on this controller and not on OpsReadController for the reason
  // batch-journey does: the analytics read is CROSS-TENANT, so guardrail G3
  // binds it to emit both the per-read 6e and the D99 cross-tenant-access entry,
  // and OpsReadController is pinned to emit zero audit records.
  //
  // 404 on an unprojected dispatch, mirroring batchJourney: "no such dispatch"
  // and "a dispatch at stage zero" must not render the same.
  @Get('dispatch/:asgnId')
  @HttpCode(200)
  async dispatchDetail(
    @Req() req: EdgeRequest,
    @Param('asgnId') asgnId: string,
    @Res({ passthrough: true }) res: EdgeResponse,
  ): Promise<unknown> {
    await this.authorize(req, 'analytics:read-dispatch-detail')
    const scope: ReadScope = { kind: 'crossTenant' }
    const detail = await readDispatchDetail(this.deps.analyticsDb, scope, asgnId)
    if (detail === null) throw new NotFoundException()
    // The delivery trail needs a parcel to have a trail. A dispatch with no
    // shipment yet gets an empty branch rather than a failed request: not
    // dispatched is a stage, not an error.
    const deliveryTrail =
      detail.shptId === null ? [] : await readShipmentTrailOps(this.deps.fulfillmentDb, detail.shptId)
    const activationTrail = await readActivationTrailOps(this.deps.tmsDb, asgnId)
    res.setHeader('x-analytics-watermark', detail.watermark.asOf ?? 'none')
    return { ...detail, deliveryTrail, activationTrail }
  }

  // GET /ops/reports/activation/batch/:btchId/xlsx: ONE batch's awaiting
  // activation worklist as the .xlsx the CWD works from. The CWD is an EXTERNAL
  // party that performs the activations, so this file leaves the platform.
  //
  // DECLARED BEFORE the generic @Get(':name') at the bottom of this class, with
  // every other specific path here. Nest registers routes in declaration order
  // and the FIRST match wins, so a specific path declared after a parameterized
  // one is swallowed by it. A single-segment `:name` cannot match this
  // four-segment path, so this particular pair would in fact survive either
  // order today; the declaration still goes first, because that ordering is the
  // rule the rest of this file already depends on (tiles/:tile,
  // batch-journey/:btchId, dispatch/:asgnId), and a later shortening of this
  // path must not be the change that discovers the exception. The resolution is
  // pinned in reports-routes.test.ts, the same way object-spine-http.test.ts
  // pins /ops/batches/:btchId against /ops/batches/:btchId/excel/:group.
  //
  // AUTHZ, in this exact order:
  //
  // 1. requireUnrestrictedRead FIRST, before the audit emit and before any DB
  //    access. This is a BINARY DOWNLOAD, so it carries the D-29/DP-8 read
  //    restriction: customer_support is denied, every unrestricted class-3 role
  //    passes. Same ordering the two ?format=csv branches use, for the same
  //    reason: a denied export must leave no ALLOW read 6e on the chain for a
  //    read that never happened. Omitting it would silently hand the export to
  //    the one role DP-8 exists to keep out of downloads.
  // 2. Then this.authorize with the EXISTING 'analytics:read-report' operation.
  //    No new permission is minted (PHASE5_DECISIONS Decision-2, "Pattern B",
  //    RULED for the activation report): the guard plus the D99 accounting 6e,
  //    reusing the report operation, with no D104 disclosure gate. Inheriting
  //    this controller's guardrail-G3 posture is the point. The read is
  //    analytics-mediated and CROSS-TENANT, so it owes both the per-read 6e and
  //    the distinct cross-tenant-access entry, and a file crossing to an
  //    external party is the last read that should be accounted for less.
  //
  // NO FILTERS are accepted, deliberately, and this is the one route here that
  // reads with an empty ReportFilters. The file is defined by its BATCH, not by
  // a window: letting ?from=/?to= narrow it would let a stray date param drop
  // devices out of a sheet that is emailed onward, and nobody at either end
  // could tell a short sheet from a complete one. A batch is already a finite,
  // server-side set; there is nothing here for a presentation filter to fix.
  //
  // This is a READ, so there is NO Idempotency-Key requirement.
  @Get('activation/batch/:btchId/xlsx')
  async activationBatchXlsx(
    @Req() req: EdgeRequest,
    @Param('btchId') btchId: string,
    @Res() res: EdgeBinaryResponse,
  ): Promise<void> {
    requireUnrestrictedRead(req.claim)
    await this.authorize(req, 'analytics:read-report')
    const scope: ReadScope = { kind: 'crossTenant' }
    const result = await readReport(this.deps.analyticsDb, scope, 'activation', {})

    const rows = result.rows.filter((row) => {
      // The btchId is a WIRE btch_ string compared as a plain string, with no
      // decode, for the reason batch-journey/:btchId already records above:
      // analytics dispatch_row.batch_id HOLDS the wire id, not a uuid, so a
      // toUuid here would throw on a value that was never a uuid. A row with a
      // null batchId has not been batched at all and matches nothing.
      if (row['batchId'] !== btchId) return false
      // NO DEVICE, NO ROW, the same rule the Activation screen enforces and
      // documents: activation is of a device plus its SIM, so a dispatch with no
      // serial paired yet has nothing the CWD could activate. Dropping it here
      // rather than leaving it to the serializer is what makes the emptiness
      // visible as a 404 below instead of as a sheet with a missing line.
      const ids = row['deviceIds']
      return Array.isArray(ids) && ids.length > 0
    })

    // 404 rather than a header-only workbook, mirroring the null path of the
    // pre-existing binary doors (ops-read.controller.ts dispatchExcel and
    // collateral) and batchJourney's reasoning: "no such batch" and "a batch
    // with nothing to activate" must not render the same. activationSheetXlsx
    // will happily emit a valid empty sheet, and that is exactly the artifact
    // that must not reach the CWD, because an empty sheet in their inbox is read
    // as a positive statement that the batch is clear.
    if (rows.length === 0) {
      res.status(404).send(Buffer.from(''))
      return
    }

    // The R-5 merge runs on the NARROWED rows only, so the fulfillment SIM read
    // asks for exactly this batch's serials rather than the whole worklist's.
    const merged = await this.mergeActivationSims(rows)
    const sheet = await activationSheetXlsx(merged)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="activation-${btchId}.xlsx"`)
    res.status(200).send(sheet)
  }

  @Get(':name')
  @HttpCode(200)
  async report(
    @Req() req: EdgeRequest,
    @Param('name') name: string,
    @Query() q: Record<string, string | undefined>,
    @Res({ passthrough: true }) res: EdgeResponse,
  ): Promise<unknown> {
    if (!REPORT_NAMES.has(name)) throw new NotFoundException()
    // D-29/DP-8: the CSV EXPORT is denied to the restricted customer_support
    // role while the JSON report view stays open, same posture and same
    // before-the-audit ordering as the tile drill-down's CSV branch above.
    if (q['format'] === 'csv') requireUnrestrictedRead(req.claim)
    await this.authorize(req, 'analytics:read-report')
    const scope: ReadScope = { kind: 'crossTenant' }
    const result = await readReport(this.deps.analyticsDb, scope, name as ReportName, toFilters(q))

    // The R-5 SIM merge (mergeActivationSims, above, where the whole rationale
    // lives). Still gated on the activation report ONLY, and still applied to
    // result.rows in place, so this route's JSON and CSV bodies are byte for
    // byte what they were before the extraction. Every other report keeps its
    // own column set and gains no simNos key.
    if (name === 'activation') {
      result.rows = await this.mergeActivationSims(result.rows)
    }

    res.setHeader('x-analytics-watermark', result.watermark.asOf ?? 'none')
    if (q['format'] === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      return toCsv(result.rows)
    }
    return result
  }
}
