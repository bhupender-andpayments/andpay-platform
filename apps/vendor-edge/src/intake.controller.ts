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

// The minimal multer file shape this route reads (mirrors the viability
// spike): avoids an @types/multer dependency for one field.
interface UploadedJson {
  buffer: Buffer
}

function parseUploadedIntakeSheet(file: UploadedJson | undefined): IntakeSheet {
  if (!file) throw new BadRequestException('missing file')
  let parsed: unknown
  try {
    parsed = JSON.parse(file.buffer.toString('utf8'))
  } catch {
    throw new BadRequestException('file is not valid JSON')
  }
  try {
    return parseIntakeSheet(parsed)
  } catch (err) {
    if (err instanceof EdgeParseError) throw new BadRequestException(err.message)
    throw err
  }
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
    const sheet = parseUploadedIntakeSheet(file)

    const decision = await authorizeAndAudit(
      { cfg: loadFulfillmentConfig(), emit: (r) => emitVendorAuthzAudit(this.deps.fulfillmentDb, r), traceId },
      req.claim,
      'sheet:submit-intake',
      { vndrId: sheet.vndrId, workQueue: sheet.workQueue },
    )
    if (!decision.allowed) throw new ForbiddenException()

    return ingestIntakeSheet(this.deps.fulfillmentDb, req.claim, sheet, traceId)
  }
}
