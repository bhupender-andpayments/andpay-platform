import {
  Controller,
  ForbiddenException,
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
  toCsv,
  type ReadScope,
  type ReportName,
  type ReportFilters,
  type TileName,
} from '@andpay/analytics-service'
import { TenantEdgeGuard } from './guard.js'
import { EDGE_DEPS, type TenantEdgeDeps } from './deps.js'
import { emitTenantAnalyticsRead } from './audit.js'
import type { EdgeRequest } from './request.js'

// The minimal response shape this controller writes to: the CSV path sets the
// content-type and the JSON path leaves Nest's default in place. @Res is used
// with { passthrough: true } so the returned value is still serialized by Nest;
// no manual res.send is ever called (S4/5c: logger stays off, nothing extra is
// written to a sink).
interface EdgeResponse {
  setHeader(name: string, value: string): void
}

// The class-2 own-scope re-derived from the VERIFIED claim (D99): programIds
// come ONLY from req.claim.scope, NEVER from a query/path/body/header. A
// request-supplied ?program_id= is never read; the legitimate presentation
// filters (?from/?to/?bank/?status) map to ReportFilters, which carries NO
// program/scope field, so no filter can widen or change the tenant boundary.
interface DerivedTenantScope {
  principalId: string
  tenantId: string | undefined
  programIds: string[]
  traceId: string
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
// ?cross_tenant are deliberately never consulted (D99: scope is the typed
// ReadScope alone, built from the claim). Absent params stay undefined so the
// mediation layer applies no window/bank narrowing.
function toFilters(q: Record<string, string | undefined>): ReportFilters {
  const filters: ReportFilters = {}
  if (typeof q['from'] === 'string') filters.from = q['from']
  if (typeof q['to'] === 'string') filters.to = q['to']
  if (typeof q['bank'] === 'string') filters.bankCode = q['bank']
  if (typeof q['status'] === 'string') filters.courierStatus = q['status']
  return filters
}

// The class-2 tenant reporting edge (spec 11 task 8, ADDITIVE). @UseGuards is
// CLASS-level so every route is authenticated by construction. Every route
// re-derives its own scope server-side (D99), emits ONE analytics-read 6e per
// read decision into the ANALYTICS outbox (ALLOW on non-empty scope, DENY
// reasonCode 'empty-scope' + 403 otherwise, BEFORE any DB access), then fans
// in-process to the analytics mediation API as a { kind: 'own' } ReadScope. A
// class-2 controller can ONLY ever construct kind:'own' (never crossTenant), so
// guardrail G1 is preserved structurally at the edge. The report PII rides the
// HTTP response body ONLY; the 6e is IDs-and-enums only (S7).
@Controller('tenant/reports')
@UseGuards(TenantEdgeGuard)
export class ReportsController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: TenantEdgeDeps) {}

  // Server-side scope re-derivation (D99). The ONLY source is the verified
  // claim. If the entitled Program set is empty (absent or []), the request is
  // authorized to read NOTHING: an analytics read-DENY 6e is emitted and 403 is
  // thrown, before any database access.
  private async authorize(req: EdgeRequest, operation: string): Promise<DerivedTenantScope> {
    const programIds = req.claim.scope.pids ?? []
    const tenantId = req.claim.scope.tid
    const scope: DerivedTenantScope = {
      principalId: req.claim.sub,
      tenantId,
      programIds,
      traceId: req.traceId,
    }
    if (programIds.length === 0) {
      await emitTenantAnalyticsRead(this.deps.analyticsDb, {
        principalId: scope.principalId,
        operation,
        decision: 'DENY',
        tenantId,
        programIds,
        traceId: scope.traceId,
        reasonCode: 'empty-scope',
      })
      throw new ForbiddenException()
    }
    await emitTenantAnalyticsRead(this.deps.analyticsDb, {
      principalId: scope.principalId,
      operation,
      decision: 'ALLOW',
      tenantId,
      programIds,
      traceId: scope.traceId,
    })
    return scope
  }

  @Get('tiles')
  @HttpCode(200)
  async tiles(@Req() req: EdgeRequest, @Query() q: Record<string, string | undefined>): Promise<unknown> {
    const { programIds } = await this.authorize(req, 'analytics:read-tiles')
    const scope: ReadScope = { kind: 'own', programIds }
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
    // Validate the tile name BEFORE the authorize/emit so an unknown tile is a
    // 404 that never records a spurious read decision.
    if (!TILE_NAMES.has(tile)) throw new NotFoundException()
    const { programIds } = await this.authorize(req, 'analytics:read-tile-drilldown')
    const scope: ReadScope = { kind: 'own', programIds }
    const result = await readTileDrilldown(this.deps.analyticsDb, scope, tile as TileName, toFilters(q))
    res.setHeader('x-analytics-watermark', result.watermark.asOf ?? 'none')
    if (q['format'] === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      return toCsv(result.rows)
    }
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
    // Validate the report name BEFORE the authorize/emit so an unknown report
    // is a 404 that never records a spurious read decision.
    if (!REPORT_NAMES.has(name)) throw new NotFoundException()
    const { programIds } = await this.authorize(req, 'analytics:read-report')
    const scope: ReadScope = { kind: 'own', programIds }
    const result = await readReport(this.deps.analyticsDb, scope, name as ReportName, toFilters(q))
    res.setHeader('x-analytics-watermark', result.watermark.asOf ?? 'none')
    if (q['format'] === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      return toCsv(result.rows)
    }
    return result
  }
}
