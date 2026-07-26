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
import { ingestReturnSheet, loadFulfillmentConfig, emitVendorAuthzAudit, type ReturnSheet } from '@andpay/fulfillment-service'
import { EdgeCredentialGuard } from './guard.js'
import { EDGE_DEPS, MAX_SHEET_BYTES, type EdgeDeps } from './deps.js'
import { parseReturnSheet, EdgeParseError } from './sheet-parse.js'
import type { EdgeRequest } from './request.js'

const RETURN_OPERATION = 'sheet:submit-return'

interface UploadedJson {
  buffer: Buffer
}

// Every rejection here (missing file, invalid JSON, or an S8 shape
// violation) is a schema-invalid parse failure alike: the caller wraps this
// in one try/catch and emits the D5.2 schema_invalid DENY audit before the
// 400, regardless of which of the three throws.
function parseUploadedReturnSheet(file: UploadedJson | undefined): ReturnSheet {
  if (!file) throw new EdgeParseError('missing file')
  let parsed: unknown
  try {
    parsed = JSON.parse(file.buffer.toString('utf8'))
  } catch {
    throw new EdgeParseError('file is not valid JSON')
  }
  return parseReturnSheet(parsed)
}

// POST /vendor/return: the print/ship vendor return sheet edge (spec 08,
// checks 3/4/7) fronting the UNCHANGED ingestReturnSheet.
@Controller('vendor')
export class ReturnController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: EdgeDeps) {}

  @Post('return')
  @UseGuards(EdgeCredentialGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SHEET_BYTES } }))
  @HttpCode(200)
  async submit(@UploadedFile() file: UploadedJson | undefined, @Req() req: EdgeRequest): Promise<unknown> {
    const traceId = randomUUID()

    let sheet: ReturnSheet
    try {
      sheet = parseUploadedReturnSheet(file)
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
      RETURN_OPERATION,
      { vndrId: sheet.vndrId, workQueue: sheet.workQueue },
    )
    if (!decision.allowed) throw new ForbiddenException()

    return ingestReturnSheet(this.deps.fulfillmentDb, req.claim, sheet, traceId)
  }

  // D5.2: a schema-invalid body is HTTP 400 PLUS an audited DENY
  // (reasonCode 'schema_invalid'). req.claim is already set by the guard
  // (the request authenticated before parsing runs), so the record carries
  // the real principal, not 'unknown'. IDs/enums only, no body, no secret.
  private async auditSchemaInvalid(req: EdgeRequest, traceId: string): Promise<void> {
    await emitVendorAuthzAudit(this.deps.fulfillmentDb, {
      principalId: req.claim.sub,
      cls: req.claim.cls,
      operation: RETURN_OPERATION,
      decision: 'DENY',
      outcome: 'denied',
      reasonCode: 'schema_invalid',
      actorChannel: 'vendor-edge',
      traceId,
    })
  }
}
