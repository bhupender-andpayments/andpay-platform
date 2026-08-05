import { randomUUID } from 'node:crypto'
import { Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Req, Res, UseGuards } from '@nestjs/common'
import { pullDispatchPackageXlsx, pullTypePdf, PullDeniedError } from '@andpay/fulfillment-service'
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

  // GET vendor/batch/:btchId/collateral/:artifactType: the FR-04 per-type merged
  // collateral PDF (SOUNDBOX_IMG = the soundbox-only view). Same D104 authz as
  // the xlsx pull (own-batch, ALLOW/DENY 6e). 404 when the batch has no artifact
  // of that type; the PDF is streamed and NEVER persisted or logged.
  @Get('batch/:btchId/collateral/:artifactType')
  @UseGuards(EdgeCredentialGuard)
  async collateral(
    @Param('btchId') btchId: string,
    @Param('artifactType') artifactType: string,
    @Req() req: EdgeRequest,
    @Res() res: EdgeResponse,
  ): Promise<void> {
    const traceId = randomUUID()
    try {
      const { pdf } = await pullTypePdf(this.deps.fulfillmentDb, this.deps.assetStore, req.claim, btchId, artifactType, traceId)
      if (pdf === null) throw new NotFoundException()
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${artifactType}-${btchId}.pdf"`)
      res.status(200).send(pdf)
    } catch (err) {
      if (err instanceof PullDeniedError) throw new ForbiddenException()
      throw err
    }
  }
}
