import { Controller, Get, HttpCode, Inject, Query, UseGuards } from '@nestjs/common'
import {
  listVendors,
  readIntakeExceptions,
  readCourierStatusExceptions,
  listBankCompositionConfigs,
  type VendorRow,
  type IntakeExceptionView,
  type CourierStatusExceptionView,
  type BankCompositionConfigRow,
} from '@andpay/fulfillment-service'
import { readQuarantineQueue, listDamageReasons, type QuarantineRowView, type DamageReasonRow } from '@andpay/tms-service'
import { OpsEdgeGuard } from './guard.js'
import { EDGE_DEPS, type OpsEdgeDeps } from './deps.js'

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
}
