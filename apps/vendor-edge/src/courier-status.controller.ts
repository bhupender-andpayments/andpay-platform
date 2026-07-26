import { randomUUID } from 'node:crypto'
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { authorizeAndAudit } from '@andpay/edge'
import { ingestStatusWebhook, loadFulfillmentConfig, emitVendorAuthzAudit } from '@andpay/fulfillment-service'
import { EdgeCredentialGuard } from './guard.js'
import { EDGE_DEPS, type EdgeDeps } from './deps.js'
import { parseWebhookBody, EdgeParseError } from './sheet-parse.js'
import type { EdgeRequest } from './request.js'

// A parsed webhook body's vndrId/workQueue are read loosely here (no throw on
// a missing/mistyped field): the real schema gate for the webhook shape is
// the handler's own per-courier mapper (status-webhook.ts), never duplicated
// at the edge. An absent field here simply cannot match the claim's own
// scope, so authorize denies on scope-denied; it never crashes.
function readVendorFields(raw: unknown): { vndrId?: string; workQueue?: string } {
  const r = raw as Record<string, unknown>
  return {
    vndrId: typeof r['vndrId'] === 'string' ? r['vndrId'] : undefined,
    workQueue: typeof r['workQueue'] === 'string' ? r['workQueue'] : undefined,
  }
}

// POST /vendor/courier/status: the webhook edge (spec 09, check 1 webhook
// channel) fronting the UNCHANGED ingestStatusWebhook. 200 on any outcome the
// handler itself signals in-band (advanced/trail_only/quarantined/deduped/
// rejected); 400 on an S8 parse failure; 403 on an authz DENY; 401 is the
// guard's own concern (never reached here).
@Controller('vendor')
export class CourierStatusController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: EdgeDeps) {}

  @Post('courier/status')
  @UseGuards(EdgeCredentialGuard)
  @HttpCode(200)
  async submit(@Body() body: unknown, @Req() req: EdgeRequest): Promise<unknown> {
    const traceId = randomUUID()

    let raw: unknown
    try {
      raw = parseWebhookBody(body)
    } catch (err) {
      if (err instanceof EdgeParseError) throw new BadRequestException(err.message)
      throw err
    }

    const { vndrId, workQueue } = readVendorFields(raw)
    const decision = await authorizeAndAudit(
      { cfg: loadFulfillmentConfig(), emit: (r) => emitVendorAuthzAudit(this.deps.fulfillmentDb, r), traceId },
      req.claim,
      'shipment:submit-status',
      { vndrId, workQueue },
    )
    if (!decision.allowed) throw new ForbiddenException()

    return ingestStatusWebhook(this.deps.fulfillmentDb, raw, req.claim, traceId)
  }
}
