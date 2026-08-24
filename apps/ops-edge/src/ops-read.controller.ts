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
  readDeviceReplacementChain,
  readUnitTrailOps,
  readPoolEntryTrailOps,
  readBatchTrailOps,
  type BatchRow,
  type BatchDetailView,
  type PoolEntryRow,
  type DispatchRow,
  type UnitInventoryRow,
  type UnitDetailView,
  type UnitReplacementChain,
  type StatusTrailRow,
  type VendorRow,
  type IntakeExceptionView,
  type CourierStatusExceptionView,
  type BankCompositionConfigRow,
  type BatchingConfigRow,
} from '@andpay/fulfillment-service'
import {
  readQuarantineQueue,
  listRequestLegsOps,
  readReplacementChainOps,
  readCaseTrailOps,
  type CaseTrailRow,
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
  type RequestLegRow,
  type ChainMemberRow,
  type DamageCaseSummary,
} from '@andpay/tms-service'
import { listBankMasters, readMerchantContacts, type BankMasterRow } from '@andpay/identity-service'
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
  // address/contact; ingest auto-minted rows carry nulls) for the admin UI.
  @Get('bank-masters')
  @HttpCode(200)
  async bankMasters(): Promise<BankMasterRow[]> {
    return listBankMasters(this.deps.identityDb)
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
  // missing. Guard-only like every read here. Unlike the four fulfillment reads
  // above this one DID need a migration, a single GRANT SELECT to tms_ops_read
  // (20260808190000). No D2 permission string was added.
  //
  // TWO READS, COMPOSED HERE, 22 Aug 2026. The BRD 5.1b block is served from
  // TMS, which snapshots it onto every assignment the bank file creates. A
  // merchant created by hand has no assignment yet and carries that block in
  // identity.merchant instead, which C4 forbids TMS from reading. So the edge
  // holds both clients and joins them in memory, exactly as
  // reports.controller.ts mergeHoldState and mergeReplacementMarks do. Neither
  // service reads the other's schema and no fact was widened to arrange it.
  //
  // FILTERING IS THE PORTAL'S JOB and stays that way. This route takes no query
  // params: the two filters the page offers are a free-text needle and a bank
  // code, both cheap over an already-loaded array, and every other ops list
  // here filters the same way. The BRD's 5,000-row figure bounds a bank FILE,
  // not the merchant table. The ceiling to watch: once merchants pass low
  // thousands the answer is server-side `?q=&bank=` plus keyset pagination, not
  // a larger payload.
  @Get('merchants')
  @HttpCode(200)
  async merchants(): Promise<MerchantRow[]> {
    const rows = await listMerchants(this.deps.tmsDb)
    return this.mergeMerchantContacts(rows)
  }

  /**
   * Fill the BRD 5.1b block for merchants TMS knows nothing about yet.
   *
   * Only ever fills a null: a merchant with requests has an assignment
   * snapshot, and that snapshot is what the bank actually sent for the most
   * recent request, so it wins over identity's copy. `address` falls back to
   * identity's composed registered_address, which is the same six-part string
   * the bank file's ship-to is built from.
   */
  private async mergeMerchantContacts(rows: MerchantRow[]): Promise<MerchantRow[]> {
    const missing = rows.filter((r) => r.contactName === null && r.mobile === null && r.address === null)
    if (missing.length === 0) return rows
    const contacts = await readMerchantContacts(
      this.deps.identityDb,
      missing.map((r) => r.mrchId),
    )
    if (contacts.size === 0) return rows
    return rows.map((row) => {
      const hit = contacts.get(row.mrchId)
      if (hit === undefined) return row
      return {
        ...row,
        contactName: row.contactName ?? hit.contactName,
        mobile: row.mobile ?? hit.mobile,
        email: row.email ?? hit.email,
        address: row.address ?? hit.registeredAddress,
        city: row.city ?? hit.city,
        state: row.state ?? hit.state,
        pincode: row.pincode ?? hit.pincode,
      }
    })
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

  // THE REPLACEMENT CHAIN through any member (DAMAGE.md). Single-context, so it
  // belongs on this controller. An unknown or non-replaced dispatch returns a
  // one-element chain (itself), which is the honest answer and lets the caller
  // render the same component either way rather than branching on empty.
  @Get('dispatches/:asgnId/chain')
  @HttpCode(200)
  async dispatchChain(@Param('asgnId') asgnId: string): Promise<ChainMemberRow[]> {
    return readReplacementChainOps(this.deps.tmsDb, asgnId)
  }

  // MERCHANT REQUESTS (DAMAGE.md): the legs, flat, newest first. The caller
  // groups by sourceEventId, which is how the pool page has always presented
  // this same relationship. Guard-only like every other read here: it exposes
  // nothing about a dispatch a class-3 operator cannot already reach, it just
  // finally answers "which dispatches belong to one merchant request".
  @Get('requests')
  @HttpCode(200)
  async requests(): Promise<RequestLegRow[]> {
    return listRequestLegsOps(this.deps.tmsDb)
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

  // One device's replacement chain, one hop each way (23 Aug 2026).
  //
  // A SEPARATE ROUTE from the detail above, on purpose. That one is the only
  // surface serving the raw manufacturer QR payload, and the device page is
  // guarded against calling it so that blob never reaches a screen which does
  // not render it. Asking "what did this device replace, and what replaced it"
  // should not cost that guard, so this route carries ids and serials only.
  // Same guard-only posture and the same 404 on an unknown unit.
  @Get('devices/:unitId/replacement-chain')
  @HttpCode(200)
  async deviceReplacementChain(@Param('unitId') unitId: string): Promise<UnitReplacementChain> {
    const chain = await readDeviceReplacementChain(this.deps.fulfillmentDb, unitId)
    if (chain === null) throw new NotFoundException('device not found')
    return chain
  }

  // STATUS_STAGES.md (21 Aug 2026): the three status trails, the siblings of
  // the shipment trail the dispatch-detail composition already serves. Same
  // guard-only posture as every other read on this controller: they expose
  // when a status this operator can already see changed, and nothing more.
  //
  // Each is SINGLE-CONTEXT (fulfillment only), which is what keeps them on
  // this controller rather than the composing reports controller.
  //
  // An empty array is a real answer, not a 404: an entity whose status has
  // never moved since the log existed has an empty trail, and the portal rail
  // renders that as "only the starting rung reached" rather than an error.
  @Get('devices/:unitId/trail')
  @HttpCode(200)
  async deviceTrail(@Param('unitId') unitId: string): Promise<StatusTrailRow[]> {
    return readUnitTrailOps(this.deps.fulfillmentDb, unitId)
  }

  @Get('dispatches/:asgnId/trail')
  @HttpCode(200)
  async dispatchTrail(@Param('asgnId') asgnId: string): Promise<StatusTrailRow[]> {
    return readPoolEntryTrailOps(this.deps.fulfillmentDb, asgnId)
  }

  @Get('batches/:btchId/trail')
  @HttpCode(200)
  async batchTrail(@Param('btchId') btchId: string): Promise<StatusTrailRow[]> {
    return readBatchTrailOps(this.deps.fulfillmentDb, btchId)
  }

  // The damage case's own trail (22 Aug 2026), tms-only, keyed like every
  // other case surface by the REPLACEMENT's asgn id. Single-context, so it
  // lives here beside its three siblings above rather than on the composing
  // reports controller. An empty array means a case born before the trail
  // existed, which the page renders as "no recorded history", not an error.
  @Get('records/:asgnId/case-trail')
  @HttpCode(200)
  async caseTrail(@Param('asgnId') asgnId: string): Promise<CaseTrailRow[]> {
    return readCaseTrailOps(this.deps.tmsDb, asgnId)
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
