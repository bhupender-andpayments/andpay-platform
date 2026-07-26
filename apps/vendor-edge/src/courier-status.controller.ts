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
import { parseWebhookBody, hasControlChar, EdgeParseError } from './sheet-parse.js'
import type { EdgeRequest } from './request.js'

const WEBHOOK_OPERATION = 'shipment:submit-status'

// A parsed webhook body's vndrId/workQueue are read loosely here (no throw on
// a missing/mistyped field): the real schema gate for the webhook shape is
// the handler's own per-courier mapper (status-webhook.ts), never duplicated
// at the edge. An absent field here simply cannot match the claim's own
// scope, so authorize denies on scope-denied; it never crashes. The ONE
// exception (m1 defense-in-depth) is a raw control byte in either field:
// that DOES throw EdgeParseError, so it can never ride through to the
// resourceIds this route hands authorizeAndAudit (and from there, the 6e
// audit record).
function readVendorFields(raw: unknown): { vndrId?: string; workQueue?: string } {
  const r = raw as Record<string, unknown>
  const vndrId = r['vndrId']
  const workQueue = r['workQueue']
  if (typeof vndrId === 'string' && hasControlChar(vndrId)) {
    throw new EdgeParseError('webhook body: "vndrId" contains a control character')
  }
  if (typeof workQueue === 'string' && hasControlChar(workQueue)) {
    throw new EdgeParseError('webhook body: "workQueue" contains a control character')
  }
  return {
    vndrId: typeof vndrId === 'string' ? vndrId : undefined,
    workQueue: typeof workQueue === 'string' ? workQueue : undefined,
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
    let vndrId: string | undefined
    let workQueue: string | undefined
    try {
      raw = parseWebhookBody(body)
      ;({ vndrId, workQueue } = readVendorFields(raw))
    } catch (err) {
      if (err instanceof EdgeParseError) {
        await this.auditSchemaInvalid(req, traceId)
        throw new BadRequestException(err.message)
      }
      throw err
    }

    const decision = await authorizeAndAudit(
      { cfg: loadFulfillmentConfig(), emit: (r) => emitVendorAuthzAudit(this.deps.fulfillmentDb, r), traceId },
      req.claim,
      WEBHOOK_OPERATION,
      { vndrId, workQueue },
    )
    if (!decision.allowed) throw new ForbiddenException()

    return ingestStatusWebhook(this.deps.fulfillmentDb, raw, req.claim, traceId)
  }

  // D5.2: a schema-invalid body is HTTP 400 PLUS an audited DENY
  // (reasonCode 'schema_invalid'), never a silent 400. The request already
  // authenticated (req.claim is set by the guard before this handler runs),
  // so the record carries the real principal, not 'unknown'. IDs/enums only,
  // no body, no secret (S10.5, S7).
  private async auditSchemaInvalid(req: EdgeRequest, traceId: string): Promise<void> {
    await emitVendorAuthzAudit(this.deps.fulfillmentDb, {
      principalId: req.claim.sub,
      cls: req.claim.cls,
      operation: WEBHOOK_OPERATION,
      decision: 'DENY',
      outcome: 'denied',
      reasonCode: 'schema_invalid',
      actorChannel: 'vendor-edge',
      traceId,
    })
  }
}
