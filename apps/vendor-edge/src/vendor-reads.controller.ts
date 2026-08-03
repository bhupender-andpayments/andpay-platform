import { randomUUID } from 'node:crypto'
import { Controller, ForbiddenException, Get, Inject, Req, UseGuards } from '@nestjs/common'
import { authorize } from '@andpay/authz'
import {
  loadFulfillmentConfig, emitVendorAuthzAudit, readVendorWorkQueue, readVendorHistory,
  type WorkQueueRow, type HistoryRow,
} from '@andpay/fulfillment-service'
import { EdgeCredentialGuard } from './guard.js'
import { EDGE_DEPS, type EdgeDeps } from './deps.js'
import type { EdgeRequest } from './request.js'

const READ_OPERATION = 'batch:read'

// GET vendor reads. scope.vndr is taken from the authenticated claim (D99);
// there is no request-body vndr to honor. Reads emit NO ALLOW audit (the
// spec-13 ops-read precedent). A permission-denied is the only DENY (a
// cross-vndr read is structurally unreachable: resource.vndrId is the
// server-derived scope.vndr), emitted standalone before the 403.
@Controller('vendor')
export class VendorReadsController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: EdgeDeps) {}

  @Get('work-queue')
  @UseGuards(EdgeCredentialGuard)
  async workQueue(@Req() req: EdgeRequest): Promise<WorkQueueRow[]> {
    await this.gate(req)
    return readVendorWorkQueue(this.deps.fulfillmentDb, req.claim.scope.vndr!)
  }

  @Get('history')
  @UseGuards(EdgeCredentialGuard)
  async history(@Req() req: EdgeRequest): Promise<HistoryRow[]> {
    await this.gate(req)
    return readVendorHistory(this.deps.fulfillmentDb, req.claim.scope.vndr!)
  }

  // scope.vndr is optional on the Scope type generically (human principals
  // never carry it), but every class-6/7 vendor claim reaching this edge
  // always has it set (D99, the same non-null convention vendor-pull.ts
  // already uses for the identical field).
  private async gate(req: EdgeRequest): Promise<void> {
    const decision = authorize(
      req.claim, READ_OPERATION, { vndrId: req.claim.scope.vndr! }, loadFulfillmentConfig(),
    )
    if (!decision.allowed) {
      await emitVendorAuthzAudit(this.deps.fulfillmentDb, {
        principalId: req.claim.sub, cls: req.claim.cls, operation: READ_OPERATION,
        decision: 'DENY', outcome: 'denied', reasonCode: decision.reason ?? 'denied',
        resourceIds: [req.claim.scope.vndr!], actorChannel: 'vendor-edge', traceId: randomUUID(),
      })
      throw new ForbiddenException()
    }
  }
}
