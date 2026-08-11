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
  toCsv,
  type ReadScope,
  type ReportName,
  type ReportFilters,
  type TileName,
} from '@andpay/analytics-service'
import { OpsEdgeGuard } from './guard.js'
import { EDGE_DEPS, type OpsEdgeDeps } from './deps.js'
import { emitOpsAnalyticsRead, emitOpsAnalyticsCrossTenant } from './audit.js'
import type { EdgeRequest } from './request.js'

// The minimal response shape this controller writes to (see the tenant edge's
// ReportsController): the CSV path sets the content-type, the JSON path leaves
// Nest's default. @Res is used with { passthrough: true } so Nest still
// serializes the returned value.
interface EdgeResponse {
  setHeader(name: string, value: string): void
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

  @Get(':name')
  @HttpCode(200)
  async report(
    @Req() req: EdgeRequest,
    @Param('name') name: string,
    @Query() q: Record<string, string | undefined>,
    @Res({ passthrough: true }) res: EdgeResponse,
  ): Promise<unknown> {
    if (!REPORT_NAMES.has(name)) throw new NotFoundException()
    await this.authorize(req, 'analytics:read-report')
    const scope: ReadScope = { kind: 'crossTenant' }
    const result = await readReport(this.deps.analyticsDb, scope, name as ReportName, toFilters(q))
    res.setHeader('x-analytics-watermark', result.watermark.asOf ?? 'none')
    if (q['format'] === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      return toCsv(result.rows)
    }
    return result
  }
}
