import { randomUUID } from 'node:crypto'
import { Controller, ForbiddenException, Get, Inject, Param, Req, Res, UseGuards } from '@nestjs/common'
import { pullDispatchPackageXlsx, PullDeniedError } from '@andpay/fulfillment-service'
import { EdgeCredentialGuard } from './guard.js'
import { EDGE_DEPS, type EdgeDeps } from './deps.js'
import type { EdgeRequest } from './request.js'

// The minimal response shape this controller writes to (mirrors
// auth-edge/login.controller.ts and ops-edge/tenant-edge's ReportsController:
// this repo does not depend on `@types/express`, so the edges type @Res
// structurally by the methods they actually call rather than pulling in the
// whole express Response type). Unlike the passthrough JSON controllers, this
// one owns the full response (binary body), so it also needs status/send.
interface EdgeResponse {
  setHeader(name: string, value: string): void
  status(code: number): EdgeResponse
  send(body: Buffer): void
}

// GET vendor/batch/:btchId/package: the FR-04 dispatch-package pull. The
// btchId is a path param (never a vndr); scope.vndr is the authenticated
// claim's (D99). The .xlsx is streamed and NEVER persisted or logged (D104/S7).
@Controller('vendor')
export class PullController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: EdgeDeps) {}

  @Get('batch/:btchId/package')
  @UseGuards(EdgeCredentialGuard)
  async pull(@Param('btchId') btchId: string, @Req() req: EdgeRequest, @Res() res: EdgeResponse): Promise<void> {
    const traceId = randomUUID()
    try {
      const { xlsx } = await pullDispatchPackageXlsx(this.deps.fulfillmentDb, req.claim, btchId, traceId)
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename="dispatch-${btchId}.xlsx"`)
      res.status(200).send(xlsx)
    } catch (err) {
      if (err instanceof PullDeniedError) throw new ForbiddenException()
      throw err
    }
  }
}
