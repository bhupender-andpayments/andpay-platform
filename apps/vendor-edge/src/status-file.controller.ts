import { randomUUID } from 'node:crypto'
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { authorizeAndAudit } from '@andpay/edge'
import {
  ingestStatusFile,
  isCourierBatchMode,
  loadFulfillmentConfig,
  emitVendorAuthzAudit,
  type StatusFile,
} from '@andpay/fulfillment-service'
import { EdgeCredentialGuard } from './guard.js'
import { EDGE_DEPS, MAX_SHEET_BYTES, type EdgeDeps } from './deps.js'
import { parseStatusFile, EdgeParseError } from './sheet-parse.js'
import type { EdgeRequest } from './request.js'

const STATUS_OPERATION = 'shipment:submit-status'

interface UploadedJson {
  buffer: Buffer
}

// Same three-ways-to-be-schema-invalid shape as the return sheet: a missing
// file, unparseable JSON, or an S8 grammar violation are one class, so the
// caller wraps them in one try/catch and emits a single D5.2 DENY.
function parseUploadedStatusFile(file: UploadedJson | undefined): StatusFile {
  if (!file) throw new EdgeParseError('missing file')
  let parsed: unknown
  try {
    parsed = JSON.parse(file.buffer.toString('utf8'))
  } catch {
    throw new EdgeParseError('file is not valid JSON')
  }
  return parseStatusFile(parsed)
}

// POST /vendor/courier/status-file: BRD FR-06 BATCH_FILE mode, the fallback
// "where webhook is unavailable", fronting the UNCHANGED ingestStatusFile.
//
// WHY THIS ROUTE EXISTS AT ALL. `ingestStatusFile` was built and tested at the
// domain layer but had ZERO callers outside its own tests: no route, no UI, no
// scheduler. So "FR-06: both modes built" was true of the domain and false of
// the transport, and a courier partner could not actually deliver a status file
// to this platform. The webhook half had a route; this half never did.
//
// WHY A VENDOR-EDGE ROUTE rather than an ops upload: it is the ONE precedent
// this repository has for a partner submitting a file. The print vendor's return
// sheet is a vendor-edge route with the partner's own class-6 credential and
// there is no ops equivalent, so this mirrors it exactly: same multipart shape,
// same parse-then-authorize-then-delegate order, same D5.2 audit on a
// schema-invalid body. `ingestStatusFile`'s signature already expected precisely
// this (a class-6 claim plus a file declaring vndrId and workQueue).
//
// NO NEW PERMISSION: `shipment:submit-status` is already granted to the
// vendor_courier set and is already what the webhook route authorizes. The two
// FR-06 modes are two transports onto one operation, which is why they share a
// dedup domain (the same transition dedup key), so the same status arriving by
// webhook AND by file collapses to `deduped` rather than double-advancing.
@Controller('vendor')
export class StatusFileController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: EdgeDeps) {}

  @Post('courier/status-file')
  @UseGuards(EdgeCredentialGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SHEET_BYTES } }))
  @HttpCode(200)
  async submit(@UploadedFile() file: UploadedJson | undefined, @Req() req: EdgeRequest): Promise<unknown> {
    const traceId = randomUUID()

    let statusFile: StatusFile
    try {
      statusFile = parseUploadedStatusFile(file)
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
      STATUS_OPERATION,
      { vndrId: statusFile.vndrId, workQueue: statusFile.workQueue },
    )
    if (!decision.allowed) throw new ForbiddenException()

    // THE INTEGRATION-MODE GATE, deliberately AFTER authorize so an
    // unauthorized caller learns nothing about a vendor's configuration. The
    // lookup itself lives in the service (isCourierBatchMode): no edge
    // controller in this repository touches SQL, and a vendor's mode is
    // fulfillment's own data. See that function for why it fails closed.
    if (!(await isCourierBatchMode(this.deps.fulfillmentDb, statusFile.vndrId))) {
      await emitVendorAuthzAudit(this.deps.fulfillmentDb, {
        principalId: req.claim.sub,
        cls: req.claim.cls,
        operation: STATUS_OPERATION,
        decision: 'DENY',
        outcome: 'denied',
        reasonCode: 'integration_mode_not_batch',
        actorChannel: 'vendor-edge',
        traceId,
      })
      throw new ForbiddenException()
    }

    return ingestStatusFile(this.deps.fulfillmentDb, statusFile, req.claim, traceId)
  }

  // D5.2: a schema-invalid body is HTTP 400 PLUS an audited DENY
  // (reasonCode 'schema_invalid'), never a silent 400. req.claim is set by the
  // guard before parsing runs, so the record carries the real principal.
  // IDs/enums only, no body, no secret.
  private async auditSchemaInvalid(req: EdgeRequest, traceId: string): Promise<void> {
    await emitVendorAuthzAudit(this.deps.fulfillmentDb, {
      principalId: req.claim.sub,
      cls: req.claim.cls,
      operation: STATUS_OPERATION,
      decision: 'DENY',
      outcome: 'denied',
      reasonCode: 'schema_invalid',
      actorChannel: 'vendor-edge',
      traceId,
    })
  }
}
