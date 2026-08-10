import { Controller, Get, HttpCode, Inject, NotFoundException, Param, Query, Res, UseGuards } from '@nestjs/common'
import {
  listVendors,
  readIntakeExceptions,
  readCourierStatusExceptions,
  listBankCompositionConfigs,
  listBatchingConfigs,
  buildDispatchPackage,
  dispatchXlsx,
  assembleGroupPdf,
  listBatches,
  readBatchDetail,
  listPoolEntries,
  listDispatches,
  listDeviceInventory,
  type BatchRow,
  type BatchDetailView,
  type PoolEntryRow,
  type DispatchRow,
  type UnitInventoryRow,
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
  type QuarantineRowView,
  type DamageReasonRow,
  type DamageCaseView,
  type MerchantRow,
} from '@andpay/tms-service'
import { listBankMasters, type BankMasterRow } from '@andpay/identity-service'
import { OpsEdgeGuard } from './guard.js'
import { EDGE_DEPS, type OpsEdgeDeps } from './deps.js'

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
  // admin list, guard-only exactly like `vendors`/`damageReasons` above (no D2
  // authorize, no 6e; the read-only DB role scopes visibility). `?tenantWire=`
  // narrows to one tenant; omitted returns every configured row.
  @Get('bank-config')
  @HttpCode(200)
  async bankConfig(@Query('tenantWire') tenantWire?: string): Promise<BankCompositionConfigRow[]> {
    return listBankCompositionConfigs(this.deps.fulfillmentDb, tenantWire !== undefined ? { tenantWire } : {})
  }

  // Phase 3 Task 6 (BRD 5.3.2): the batching-parameter admin list, guard-only
  // exactly like the reads above (no D2 authorize, no 6e; the read-only DB role
  // scopes visibility). Returns every configured scope row (GLOBAL, per-tenant,
  // per-(tenant,program)) for the admin UI. NOTE: this GET is guard-only, so
  // any authenticated class-3 operator can VIEW the batching config; only the
  // WRITE (POST) is admin/super_admin-gated (T6 differentiation).
  @Get('batching-config')
  @HttpCode(200)
  async batchingConfig(): Promise<BatchingConfigRow[]> {
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

  // Phase 4 (BRD 5.3 FR-03 / FR-04, P4-D6): the Phase-1 dispatch-package hand-off
  // surface -- the AndPayments ops team downloads the package to send to the
  // print vendor. Guard-only like every read here (no D2 authorize, no 6e); the
  // ship-view PII an entitled operator sees mirrors the accepted internal-read
  // posture (A.2). The Excel is the bank+branch-sorted dispatch sheet.
  @Get('batches/:btchId/dispatch-excel')
  async dispatchExcel(@Param('btchId') btchId: string, @Res() res: EdgeResponse): Promise<void> {
    const lines = await buildDispatchPackage(this.deps.fulfillmentDb, btchId, 'ship')
    const xlsx = await dispatchXlsx(lines)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="dispatch-${btchId}.xlsx"`)
    res.status(200).send(xlsx)
  }

  // The merged collateral PDF for a DELIVERY GROUP: 'SOUNDBOX' (the FR-04
  // soundbox-only view) or 'COLLATERAL' (sticker plus standee, one page per
  // merchant). The three legacy artifact-type values still resolve to the group
  // carrying that product, so a URL an operator already holds keeps working.
  // 404 when the batch has nothing in that group, and for an unknown key, which
  // is the same null path an unknown artifact type took before.
  @Get('batches/:btchId/collateral/:collateralKey')
  async collateral(
    @Param('btchId') btchId: string,
    @Param('collateralKey') collateralKey: string,
    @Res() res: EdgeResponse,
  ): Promise<void> {
    const pdf = await assembleGroupPdf(this.deps.fulfillmentDb, this.deps.assetStore, btchId, collateralKey)
    if (pdf === null) {
      res.status(404).send(Buffer.from(''))
      return
    }
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${collateralKey}-${btchId}.pdf"`)
    res.status(200).send(Buffer.from(pdf))
  }
}
