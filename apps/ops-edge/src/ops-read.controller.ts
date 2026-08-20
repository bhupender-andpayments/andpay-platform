import {
  BadRequestException,
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
import { toUuid } from '@andpay/ids'
import {
  listVendors,
  readIntakeExceptions,
  readCourierStatusExceptions,
  listBankCompositionConfigs,
  listBatchingConfigs,
  buildDispatchGroupXlsx,
  resolveCollateralGroup,
  assembleGroupPdf,
  listBatches,
  readBatchDetail,
  listPoolEntries,
  listDispatches,
  listDeviceInventory,
  readDeviceDetail,
  type BatchRow,
  type BatchDetailView,
  type PoolEntryRow,
  type DispatchRow,
  type UnitInventoryRow,
  type UnitDetailView,
  type VendorRow,
  type IntakeExceptionView,
  type CourierStatusExceptionView,
  type BankCompositionConfigRow,
  type BatchingConfigRow,
} from '@andpay/fulfillment-service'
import {
  readQuarantineQueue,
  listDamageReasons,
  readDamageCases,
  listMerchants,
  searchDispatchesByVpa,
  countDamageCasesByStatus,
  type QuarantineRowView,
  type DamageReasonRow,
  type DamageCaseView,
  type MerchantRow,
  type VpaDispatchRow,
  type DamageCaseSummary,
} from '@andpay/tms-service'
import { listBankMasters, type AggregatorRow, type BankMasterRow } from '@andpay/identity-service'
import { OpsEdgeGuard } from './guard.js'
import { EDGE_DEPS, type OpsEdgeDeps } from './deps.js'
import { requireUnrestrictedRead } from './read-restriction.js'
import type { EdgeRequest } from './request.js'

// The minimal response shape the binary download routes write to (same
// structural typing the vendor-edge PullController and the ReportsController
// use: this repo does not depend on @types/express). A binary body needs
// setHeader + status + send.
interface EdgeResponse {
  setHeader(name: string, value: string): void
  status(code: number): EdgeResponse
  send(body: Buffer): void
}

// The class-3 ops READ edge (spec 10c, Task 9). Guard-only (an authenticated
// class-3 operator): reads are NOT mutations (check 3), so there is NO per-op
// D2 authorize and NO 6e emit here. The `fulfillment_ops_read` / `tms_ops_read`
// DB roles the read APIs set internally scope the visible data; a read attempt
// under the tenant read role hits a Postgres permission-denied, not an empty
// result. @UseGuards is at the CLASS level so every route is authenticated by
// construction. `?includeResolved=true` opts a queue into its resolved rows;
// the default is the open (unresolved) queue.
//
// ONE narrow exception to pure guard-only (D-29, DAMAGE_PLAN DP-8, 16 Aug
// 2026): the binary downloads and the two config views additionally run
// requireUnrestrictedRead (read-restriction.ts), a role-keyed deny list for
// customer_support, which must have no download and no config access. It
// throws a bare 403 and emits NOTHING, so this controller's zero-audit pin
// (object-spine-http.test.ts) still holds for every route.
@Controller('ops')
@UseGuards(OpsEdgeGuard)
export class OpsReadController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: OpsEdgeDeps) {}

  @Get('vendors')
  @HttpCode(200)
  async vendors(): Promise<VendorRow[]> {
    return listVendors(this.deps.fulfillmentDb)
  }

  // Phase 3 Task 1 (BRD FR-08, FR-11): the damage_reason master list, guard-
  // only exactly like `vendors` above (no D2 authorize, no 6e; the read-only
  // DB role scopes the visible data). Returns every row (active and
  // inactive) so the admin UI can toggle either direction.
  @Get('damage-reasons')
  @HttpCode(200)
  async damageReasons(): Promise<DamageReasonRow[]> {
    return listDamageReasons(this.deps.tmsDb)
  }

  @Get('quarantine')
  @HttpCode(200)
  async quarantine(@Query('includeResolved') includeResolved?: string): Promise<QuarantineRowView[]> {
    return readQuarantineQueue(this.deps.tmsDb, { includeResolved: includeResolved === 'true' })
  }

  // FR08-2 (BRD 5.8): the ops damage-case working list. Defaults to open cases;
  // ?includeClosed=true shows all. Emits wire asgn ids for the transition write.
  @Get('damage-cases')
  @HttpCode(200)
  async damageCases(@Query('includeClosed') includeClosed?: string): Promise<DamageCaseView[]> {
    return readDamageCases(this.deps.tmsDb, { includeClosed: includeClosed === 'true' })
  }

  // D-31 (DAMAGE_PLAN B3/DP-7): case counts by status for the dashboard tile.
  // Served from TMS, not analytics, because case_status is deliberately never
  // projected into analytics; guard-only exactly like `damageCases` above.
  // Registration order does not matter here: 'damage-cases' is an exact path
  // and cannot capture 'damage-cases/summary'.
  @Get('damage-cases/summary')
  @HttpCode(200)
  async damageCaseSummary(): Promise<DamageCaseSummary> {
    return countDamageCasesByStatus(this.deps.tmsDb)
  }

  @Get('exceptions/intake')
  @HttpCode(200)
  async intakeExceptions(@Query('includeResolved') includeResolved?: string): Promise<IntakeExceptionView[]> {
    return readIntakeExceptions(this.deps.fulfillmentDb, { includeResolved: includeResolved === 'true' })
  }

  @Get('exceptions/status')
  @HttpCode(200)
  async statusExceptions(@Query('includeResolved') includeResolved?: string): Promise<CourierStatusExceptionView[]> {
    return readCourierStatusExceptions(this.deps.fulfillmentDb, { includeResolved: includeResolved === 'true' })
  }

  // Phase 3 Task 5b (BRD Annexure D.4): the bank/branch composition-config
  // admin list. A CONFIG VIEW, so it carries the D-29/DP-8 read restriction
  // (customer_support is denied; every unrestricted class-3 role passes with
  // no D2 authorize and no 6e, the read-only DB role scoping visibility as
  // before). `?tenantWire=` narrows to one tenant; omitted returns every
  // configured row.
  @Get('bank-config')
  @HttpCode(200)
  async bankConfig(@Req() req: EdgeRequest, @Query('tenantWire') tenantWire?: string): Promise<BankCompositionConfigRow[]> {
    requireUnrestrictedRead(req.claim)
    return listBankCompositionConfigs(this.deps.fulfillmentDb, tenantWire !== undefined ? { tenantWire } : {})
  }

  // Phase 3 Task 6 (BRD 5.3.2): the batching-parameter admin list. A CONFIG
  // VIEW, so like bank-config above it carries the D-29/DP-8 read restriction:
  // customer_support is denied; any OTHER authenticated class-3 operator can
  // still VIEW the batching config with no D2 authorize and no 6e, and only
  // the WRITE (POST) is admin/super_admin-gated (T6 differentiation). Returns
  // every configured scope row (GLOBAL, per-tenant, per-(tenant,program)) for
  // the admin UI.
  @Get('batching-config')
  @HttpCode(200)
  async batchingConfig(@Req() req: EdgeRequest): Promise<BatchingConfigRow[]> {
    requireUnrestrictedRead(req.claim)
    return listBatchingConfigs(this.deps.fulfillmentDb)
  }

  // Phase 3 Task 7 (BRD Annexure D): the Bank Master (identity.tenant) list,
  // guard-only exactly like the reads above (no D2 authorize, no 6e). Calls
  // identity's own listBankMasters with deps.identityDb (no cross-context DB
  // read, C4). Returns every Bank Master (admin-created rows carry the full
  // address/contact; ingest auto-minted rows carry nulls) nested with its
  // `aggregators` (spec 2026-08-20; every tenant carries at least its own
  // default aggregator) for the admin UI.
  //
  // Task 5 (2026-08-19), re-homed to the aggregator (spec 2026-08-20): composes
  // in `hasLogo`, a PRESENCE boolean only, per AGGREGATOR, from fulfillment's
  // bank_composition_config (a row with an EMPTY branchCode is the bank-level
  // composition row a logo lands on, keyed on the aggregator's own code). No
  // config DETAIL crosses the boundary, only the boolean; both reads are
  // in-process domain calls (no cross-schema SQL, C4).
  @Get('bank-masters')
  @HttpCode(200)
  async bankMasters(): Promise<(BankMasterRow & { aggregators: (AggregatorRow & { hasLogo: boolean })[] })[]> {
    const rows = await listBankMasters(this.deps.identityDb)
    const configs = await listBankCompositionConfigs(this.deps.fulfillmentDb)
    // Keyed on (tenantId, bankCode), not bankCode alone: two tenants can
    // legitimately share an aggregator code, and a bare-code Set would let
    // one tenant's uploaded logo read as present on the other's aggregator
    // of the same code.
    const withLogo = new Set(
      configs
        .filter((c) => c.branchCode === '' && c.logoMasterRef !== null)
        .map((c) => `${c.tenantId}:${c.bankCode}`),
    )
    return rows.map((r) => ({
      ...r,
      aggregators: r.aggregators.map((a) => ({
        ...a,
        hasLogo: withLogo.has(`${toUuid(a.tnntId)}:${a.aggregatorCode}`),
      })),
    }))
  }

  // ROUTE ORDER: both aggregators/:aggrId/logo/* reads below MUST be
  // registered before any future aggregators/:id catch-all (none exists
  // today), or a generic :id route would swallow the /logo/versions and
  // /logo/derivative segments as a param match.
  //
  // Guard-only exactly like bank-masters above (no requireUnrestrictedRead): a
  // logo is print collateral input, not config detail, matching the list's own
  // posture. Resolves the aggregator's own code via the same in-process
  // identity call (spec 2026-08-20, re-homed from the tenant-keyed routes
  // these replace).
  @Get('aggregators/:aggrId/logo/versions')
  @HttpCode(200)
  async aggregatorLogoVersions(
    @Param('aggrId') aggrId: string,
  ): Promise<{ version: string; filename: string; contentType: string }[]> {
    const rows = await listBankMasters(this.deps.identityDb)
    const agg = rows.flatMap((r) => r.aggregators).find((a) => a.aggrId === aggrId)
    if (agg === undefined) return []
    const versions = await this.deps.assetStore.listVersions(agg.aggregatorCode)
    return versions.map((v) => ({ version: v.version, filename: v.meta.filename, contentType: v.meta.contentType }))
  }

  // The preview behind each row of the versions list above: the MASTER bytes
  // at that exact token. The list is the master key's history, so its tokens
  // are authoritative HERE and only here; the derivative key runs its own
  // version sequence (per the AssetStore port) and matching across the two by
  // token would silently serve the wrong artwork whenever they drift. The
  // portal rasterizes the returned .ai in the browser, the same way it
  // previews a freshly picked file.
  @Get('aggregators/:aggrId/logo/versions/:version/master')
  async aggregatorLogoVersionMaster(
    @Param('aggrId') aggrId: string,
    @Param('version') version: string,
    @Res() res: EdgeResponse,
  ): Promise<void> {
    const rows = await listBankMasters(this.deps.identityDb)
    const agg = rows.flatMap((r) => r.aggregators).find((a) => a.aggrId === aggrId)
    const versions = agg === undefined ? [] : await this.deps.assetStore.listVersions(agg.aggregatorCode)
    const match = versions.find((v) => v.version === version)
    const rec = match === undefined ? null : await this.deps.assetStore.getByReference(match.reference)
    if (rec === null) {
      res.status(404).send(Buffer.from(''))
      return
    }
    res.setHeader('Content-Type', rec.meta.contentType)
    res.status(200).send(Buffer.from(rec.bytes))
  }

  @Get('aggregators/:aggrId/logo/derivative')
  async aggregatorLogoDerivative(@Param('aggrId') aggrId: string, @Res() res: EdgeResponse): Promise<void> {
    const rows = await listBankMasters(this.deps.identityDb)
    const agg = rows.flatMap((r) => r.aggregators).find((a) => a.aggrId === aggrId)
    const rec = agg === undefined ? null : await this.deps.assetStore.getCurrent(`${agg.aggregatorCode}:derivative`)
    if (rec === null) {
      res.status(404).send(Buffer.from(''))
      return
    }
    res.setHeader('Content-Type', rec.meta.contentType)
    res.status(200).send(Buffer.from(rec.bytes))
  }

  // P2-1: the object-spine reads. Guard-only exactly like every read above (no
  // D2 authorize, no 6e; the fulfillment_ops_read role scopes visibility). These
  // four close the gap where the ONLY batch-shaped read was
  // download-by-typed-id: the portal could fetch a batch's Excel but had no way
  // to LIST batches and find one. All are PII-free projections (see ops-read.ts).
  @Get('batches')
  @HttpCode(200)
  async batches(): Promise<BatchRow[]> {
    return listBatches(this.deps.fulfillmentDb)
  }

  // Redesign step 7 (ruling 1b): the merchant list the entity-first nav was
  // missing. Guard-only like every read here, and served from the TMS db
  // (merchant_projection), not identity, so no context boundary is crossed.
  // Unlike the four fulfillment reads above this one DID need a migration, a
  // single GRANT SELECT to tms_ops_read (20260808190000). No D2 permission
  // string was added.
  @Get('merchants')
  @HttpCode(200)
  async merchants(): Promise<MerchantRow[]> {
    return listMerchants(this.deps.tmsDb)
  }

  // `?poolStatus=POOLED|HELD|BATCHED` narrows the queue; omitted returns the
  // whole pool. Registered BEFORE `batches/:btchId` is irrelevant here (a
  // different path), but the pool route is deliberately its own noun rather than
  // `batches/pending`, which WOULD have been captured by the :btchId param.
  @Get('pool')
  @HttpCode(200)
  async pool(@Query('poolStatus') poolStatus?: string): Promise<PoolEntryRow[]> {
    return listPoolEntries(this.deps.fulfillmentDb, poolStatus !== undefined ? { poolStatus } : {})
  }

  @Get('dispatches')
  @HttpCode(200)
  async dispatches(@Query('status') status?: string): Promise<DispatchRow[]> {
    return listDispatches(this.deps.fulfillmentDb, status !== undefined ? { status } : {})
  }

  // D-26 (DAMAGE_PLAN B2/DP-6): find every dispatch leg for one merchant VPA,
  // the operator's entry point into the flag-damage flow. Served from TMS
  // (assignment owns vpa_value; the existing lower(vpa_value) index carries
  // the match), guard-only like every read here, so no context boundary
  // moves. A blank or missing ?vpa= is a 400, not an unbounded scan.
  // Registration order does not matter: 'dispatches' above is an exact path
  // and cannot capture 'dispatches/by-vpa'.
  @Get('dispatches/by-vpa')
  @HttpCode(200)
  async dispatchesByVpa(@Query('vpa') vpa?: string): Promise<{ rows: VpaDispatchRow[] }> {
    if (typeof vpa !== 'string' || vpa.trim() === '') {
      throw new BadRequestException('vpa query parameter is required')
    }
    return { rows: await searchDispatchesByVpa(this.deps.tmsDb, vpa) }
  }

  // The device inventory. Guard-only, like the other reads on this controller:
  // no new D2 permission string is minted for it, because it exposes nothing a
  // class-3 ops principal cannot already reach about a device through a batch
  // or a dispatch. The ICCID and the manufacturer QR payload are excluded BY
  // GRANT rather than here, so this cannot widen by accident.
  @Get('devices')
  @HttpCode(200)
  async devices(@Query('status') status?: string): Promise<UnitInventoryRow[]> {
    return listDeviceInventory(this.deps.fulfillmentDb, status !== undefined ? { status } : {})
  }

  // One device, on demand. This is the ONLY route that serves the full ICCID
  // and the raw manufacturer QR payload (2026-08-12 product ruling; the list
  // above carries a masked SIM only). Same guard-only posture as the list; a
  // 404 on an unknown unit mirrors batchDetail. A malformed id throws out of
  // toUuid inside readDeviceDetail and is mapped by the ops error filter.
  @Get('devices/:unitId')
  @HttpCode(200)
  async deviceDetail(@Param('unitId') unitId: string): Promise<UnitDetailView> {
    const detail = await readDeviceDetail(this.deps.fulfillmentDb, unitId)
    if (detail === null) throw new NotFoundException('device not found')
    return detail
  }

  // 404 on an unknown batch rather than an empty-but-valid-looking detail, so
  // the UI cannot render a batch that does not exist. A malformed id throws out
  // of toUuid and is mapped by the ops error filter.
  @Get('batches/:btchId')
  @HttpCode(200)
  async batchDetail(@Param('btchId') btchId: string): Promise<BatchDetailView> {
    const detail = await readBatchDetail(this.deps.fulfillmentDb, btchId)
    if (detail === null) throw new NotFoundException('batch not found')
    return detail
  }

  // Phase 1 dispatch-package hand-off, per the 2026-08-10 E1 ruling: TWO Excels
  // per batch, one per delivery group, on the same group vocabulary (and legacy
  // artifact-type key mapping) the collateral PDF route below already uses. One
  // resolver, two media types. A BINARY DOWNLOAD, so it carries the D-29/DP-8
  // read restriction (customer_support is denied; every unrestricted class-3
  // role passes with no D2 authorize and no 6e); the ship-view PII an entitled
  // operator sees mirrors the accepted internal-read posture (A.2). 404 on an
  // unknown group key, the same null path the PDF route takes.
  @Get('batches/:btchId/excel/:groupKey')
  async dispatchExcel(
    @Req() req: EdgeRequest,
    @Param('btchId') btchId: string,
    @Param('groupKey') groupKey: string,
    @Res() res: EdgeResponse,
  ): Promise<void> {
    requireUnrestrictedRead(req.claim)
    const group = resolveCollateralGroup(groupKey)
    if (group === null) {
      res.status(404).send(Buffer.from(''))
      return
    }
    // D-11 exception (13 Aug 2026): the sheet's count columns are worded for the
    // bound vendor's press, so an operator downloading it sees exactly what the
    // vendor's own pull produces. Both doors go through buildDispatchGroupXlsx
    // precisely so neither can resolve the press differently, or forget to.
    const xlsx = await buildDispatchGroupXlsx(this.deps.fulfillmentDb, btchId, group, 'ship')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    // Batch id FIRST (18 Aug 2026, at the user's correction): several of these
    // pile up in one Downloads folder across different batches, sorted
    // alphabetically, and a btch_... id buried in the middle of the name is
    // what read as "random" when trying to tell which files belong together.
    res.setHeader('Content-Disposition', `attachment; filename="${btchId}-dispatch-${group.toLowerCase()}.xlsx"`)
    res.status(200).send(xlsx)
  }

  // The merged collateral PDF for a DELIVERY GROUP: 'SOUNDBOX' (the FR-04
  // soundbox-only view) or 'COLLATERAL' (sticker plus standee, one page per
  // merchant). The three legacy artifact-type values still resolve to the group
  // carrying that product, so a URL an operator already holds keeps working.
  // 404 when the batch has nothing in that group, and for an unknown key, which
  // is the same null path an unknown artifact type took before. A BINARY
  // DOWNLOAD, so it carries the D-29/DP-8 read restriction exactly like the
  // Excel route above.
  @Get('batches/:btchId/collateral/:collateralKey')
  async collateral(
    @Req() req: EdgeRequest,
    @Param('btchId') btchId: string,
    @Param('collateralKey') collateralKey: string,
    @Res() res: EdgeResponse,
  ): Promise<void> {
    requireUnrestrictedRead(req.claim)
    const pdf = await assembleGroupPdf(this.deps.fulfillmentDb, this.deps.assetStore, btchId, collateralKey)
    if (pdf === null) {
      res.status(404).send(Buffer.from(''))
      return
    }
    res.setHeader('Content-Type', 'application/pdf')
    // Batch id first, same reasoning as the Excel route above.
    res.setHeader('Content-Disposition', `attachment; filename="${btchId}-${collateralKey.toLowerCase()}.pdf"`)
    res.status(200).send(Buffer.from(pdf))
  }
}
