import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common'
import {
  readAssignments,
  readAssignmentById,
  type AssignmentReadRow,
} from '@andpay/tms-service'
import {
  readShipments,
  readShipmentStatusTrail,
  type ShipmentReadRow,
  type ShipmentStatusEventRow,
} from '@andpay/fulfillment-service'
import { TenantEdgeGuard } from './guard.js'
import { EDGE_DEPS, type TenantEdgeDeps } from './deps.js'
import { emitTenantReadAudit } from './audit.js'
import type { EdgeRequest } from './request.js'

// The scope re-derived from the VERIFIED claim the guard attached. D99
// (CRITICAL): programIds and tenantId come ONLY from `req.claim.scope`, NEVER
// from the query string, path, body, or headers. The read APIs then gate every
// SELECT on `WHERE program_id = ANY(programIds)` plus the RESTRICTIVE tenant-read
// RLS policy, so a request-supplied `?program_id=` is simply never read and can
// neither widen nor change the result.
interface DerivedScope {
  principalId: string
  tenantId: string | undefined
  programIds: string[]
  traceId: string
}

// The tenant class-2 READ edge (spec 10b, D-5). @UseGuards is declared at the
// CLASS level so EVERY route is authenticated by construction (a Task-5 panel
// carry-forward: never rely on a per-method @UseGuards that a future route
// could forget). Every route re-derives its scope server-side (D99), emits ONE
// 6e authz-audit record per read decision (ALLOW on non-empty scope, DENY
// reasonCode 'empty-scope' otherwise), then calls the in-process read API and
// returns the DTO. The tenant's own ship-to PII (Fork F) rides the HTTP
// response body ONLY. This edge imports NO identity service: the merchant /
// ship-to snapshot is sourced entirely from tms.assignment (check 6).
@Controller('tenant')
@UseGuards(TenantEdgeGuard)
export class ReadController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: TenantEdgeDeps) {}

  // Server-side scope re-derivation (D99). The ONLY source is the verified
  // claim. If the entitled Program set is empty (absent or []), the request is
  // authorized to read NOTHING: a read-DENY 6e is emitted and 403 is thrown,
  // before any database access.
  private async authorize(req: EdgeRequest, operation: string): Promise<DerivedScope> {
    const programIds = req.claim.scope.pids ?? []
    const tenantId = req.claim.scope.tid
    const scope: DerivedScope = {
      principalId: req.claim.sub,
      tenantId,
      programIds,
      traceId: req.traceId,
    }
    if (programIds.length === 0) {
      await emitTenantReadAudit(this.deps.fulfillmentDb, {
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
    await emitTenantReadAudit(this.deps.fulfillmentDb, {
      principalId: scope.principalId,
      operation,
      decision: 'ALLOW',
      tenantId,
      programIds,
      traceId: scope.traceId,
    })
    return scope
  }

  @Get('assignments')
  @HttpCode(200)
  async assignments(@Req() req: EdgeRequest): Promise<AssignmentReadRow[]> {
    const { programIds } = await this.authorize(req, 'tenant:read-assignments')
    return readAssignments(this.deps.tmsDb, programIds)
  }

  @Get('assignments/:id')
  @HttpCode(200)
  async assignmentById(@Req() req: EdgeRequest, @Param('id') id: string): Promise<AssignmentReadRow> {
    const { programIds } = await this.authorize(req, 'tenant:read-assignment-detail')
    // The :id narrows WITHIN the claim scope; the read API still gates on
    // program_id = ANY(programIds), so an out-of-scope id resolves to null.
    const row = await readAssignmentById(this.deps.tmsDb, programIds, id)
    if (row === null) throw new NotFoundException()
    return row
  }

  @Get('shipments')
  @HttpCode(200)
  async shipments(@Req() req: EdgeRequest): Promise<ShipmentReadRow[]> {
    const { programIds } = await this.authorize(req, 'tenant:read-shipments')
    return readShipments(this.deps.fulfillmentDb, programIds)
  }

  @Get('shipments/:id/status')
  @HttpCode(200)
  async shipmentStatus(@Req() req: EdgeRequest, @Param('id') id: string): Promise<ShipmentStatusEventRow[]> {
    const { programIds } = await this.authorize(req, 'tenant:read-shipment-status')
    // An out-of-scope shpt id yields an empty trail (the read API gates on
    // program_id = ANY(programIds) AND shpt_id = id), never a leak.
    return readShipmentStatusTrail(this.deps.fulfillmentDb, programIds, id)
  }
}
