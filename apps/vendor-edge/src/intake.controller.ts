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
import { ingestIntakeSheet, loadFulfillmentConfig, emitVendorAuthzAudit, type IntakeSheet } from '@andpay/fulfillment-service'
import { EdgeCredentialGuard } from './guard.js'
import { EDGE_DEPS, MAX_SHEET_BYTES, type EdgeDeps } from './deps.js'
import { parseIntakeSheet, EdgeParseError } from './sheet-parse.js'
import type { EdgeRequest } from './request.js'

const INTAKE_OPERATION = 'sheet:submit-intake'

// The minimal multer file shape this route reads (mirrors the viability
// spike): avoids an @types/multer dependency for one field.
interface UploadedJson {
  buffer: Buffer
}

// Every rejection here (missing file, invalid JSON, or an S8 shape
// violation) is a schema-invalid parse failure alike: the caller wraps this
// in one try/catch and emits the D5.2 schema_invalid DENY audit before the
// 400, regardless of which of the three throws.
function parseUploadedIntakeSheet(file: UploadedJson | undefined): IntakeSheet {
  if (!file) throw new EdgeParseError('missing file')
  let parsed: unknown
  try {
    parsed = JSON.parse(file.buffer.toString('utf8'))
  } catch {
    throw new EdgeParseError('file is not valid JSON')
  }
  return parseIntakeSheet(parsed)
}

// POST /vendor/intake: the manufacturer intake sheet edge (spec 07, checks
// 1/5/6) fronting the UNCHANGED ingestIntakeSheet. Multipart file upload
// ("file"), parsed and S8-validated at the edge before any authorize.
@Controller('vendor')
export class IntakeController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: EdgeDeps) {}

  @Post('intake')
  @UseGuards(EdgeCredentialGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SHEET_BYTES } }))
  @HttpCode(200)
  async submit(@UploadedFile() file: UploadedJson | undefined, @Req() req: EdgeRequest): Promise<unknown> {
    const traceId = randomUUID()

    let sheet: IntakeSheet
    try {
      sheet = parseUploadedIntakeSheet(file)
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
      INTAKE_OPERATION,
      { vndrId: sheet.vndrId, workQueue: sheet.workQueue },
    )
    if (!decision.allowed) throw new ForbiddenException()

    return ingestIntakeSheet(this.deps.fulfillmentDb, req.claim, sheet, traceId)
  }

  // D5.2: a schema-invalid body is HTTP 400 PLUS an audited DENY
  // (reasonCode 'schema_invalid'). req.claim is already set by the guard
  // (the request authenticated before parsing runs), so the record carries
  // the real principal, not 'unknown'. IDs/enums only, no body, no secret.
  private async auditSchemaInvalid(req: EdgeRequest, traceId: string): Promise<void> {
    await emitVendorAuthzAudit(this.deps.fulfillmentDb, {
      principalId: req.claim.sub,
      cls: req.claim.cls,
      operation: INTAKE_OPERATION,
      decision: 'DENY',
      outcome: 'denied',
      reasonCode: 'schema_invalid',
      actorChannel: 'vendor-edge',
      traceId,
    })
  }
}
