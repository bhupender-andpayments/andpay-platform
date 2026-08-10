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

// GET vendor/batch/:btchId/package/:groupKey: the FR-04 dispatch-package pull,
// now PER DELIVERY GROUP, same key grammar as the collateral route below
// ('SOUNDBOX' or 'COLLATERAL'). The btchId is a path param (never a vndr);
// scope.vndr is the authenticated claim's (D99). An unrecognized groupKey is a
// 404, mirroring the collateral route directly below; the bare `/package`
// path this route used to answer is now gone, no different from any other
// unmatched route. The .xlsx is streamed and NEVER persisted or logged
// (D104/S7).
@Controller('vendor')
export class PullController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: EdgeDeps) {}

  @Get('batch/:btchId/package/:groupKey')
  @UseGuards(EdgeCredentialGuard)
  async pull(
    @Param('btchId') btchId: string,
    @Param('groupKey') groupKey: string,
    @Req() req: EdgeRequest,
    @Res() res: EdgeResponse,
  ): Promise<void> {
    const traceId = randomUUID()
    try {
      const { xlsx } = await pullDispatchPackageXlsx(this.deps.fulfillmentDb, req.claim, btchId, groupKey, traceId)
      if (xlsx === null) throw new NotFoundException()
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename="dispatch-${groupKey}-${btchId}.xlsx"`)
      res.status(200).send(xlsx)
    } catch (err) {
      if (err instanceof PullDeniedError) throw new ForbiddenException()
      throw err
    }
  }

  // GET vendor/batch/:btchId/collateral/:collateralKey: the FR-04 merged
  // collateral PDF for a DELIVERY GROUP, 'SOUNDBOX' (the soundbox-only view) or
  // 'COLLATERAL' (sticker plus standee, one page per merchant). The three legacy
  // artifact-type values still resolve to the group carrying that product, so a
  // URL a vendor already holds keeps working. Same D104 authz as the xlsx pull
  // (own-batch, ALLOW/DENY 6e). 404 when the batch has nothing in that group, or
  // on an unknown key; the PDF is streamed and NEVER persisted or logged.
  @Get('batch/:btchId/collateral/:collateralKey')
  @UseGuards(EdgeCredentialGuard)
  async collateral(
    @Param('btchId') btchId: string,
    @Param('collateralKey') collateralKey: string,
    @Req() req: EdgeRequest,
    @Res() res: EdgeResponse,
  ): Promise<void> {
    const traceId = randomUUID()
    try {
      const { pdf } = await pullTypePdf(this.deps.fulfillmentDb, this.deps.assetStore, req.claim, btchId, collateralKey, traceId)
      if (pdf === null) throw new NotFoundException()
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${collateralKey}-${btchId}.pdf"`)
      res.status(200).send(pdf)
    } catch (err) {
      if (err instanceof PullDeniedError) throw new ForbiddenException()
      throw err
    }
  }
}
