import { Controller, Get, HttpCode, Inject, Param, Query, Res, UseGuards } from '@nestjs/common'
import {
  listVendors,
  readIntakeExceptions,
  readCourierStatusExceptions,
  listBankCompositionConfigs,
  listBatchingConfigs,
  buildDispatchPackage,
  dispatchXlsx,
  assembleTypePdf,
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
  type QuarantineRowView,
  type DamageReasonRow,
  type DamageCaseView,
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

  // The per-product-type merged collateral PDF (SOUNDBOX_IMG is the FR-04
  // soundbox-only view). 404 when the batch has no artifact of that type.
  @Get('batches/:btchId/collateral/:artifactType')
  async collateral(
    @Param('btchId') btchId: string,
    @Param('artifactType') artifactType: string,
    @Res() res: EdgeResponse,
  ): Promise<void> {
    const pdf = await assembleTypePdf(this.deps.fulfillmentDb, this.deps.assetStore, btchId, artifactType)
    if (pdf === null) {
      res.status(404).send(Buffer.from(''))
      return
    }
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${artifactType}-${btchId}.pdf"`)
    res.status(200).send(Buffer.from(pdf))
  }
}
