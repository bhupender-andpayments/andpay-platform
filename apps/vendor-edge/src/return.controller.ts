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

interface UploadedJson {
  buffer: Buffer
}

function parseUploadedReturnSheet(file: UploadedJson | undefined): ReturnSheet {
  if (!file) throw new BadRequestException('missing file')
  let parsed: unknown
  try {
    parsed = JSON.parse(file.buffer.toString('utf8'))
  } catch {
    throw new BadRequestException('file is not valid JSON')
  }
  try {
    return parseReturnSheet(parsed)
  } catch (err) {
    if (err instanceof EdgeParseError) throw new BadRequestException(err.message)
    throw err
  }
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
    const sheet = parseUploadedReturnSheet(file)

    const decision = await authorizeAndAudit(
      { cfg: loadFulfillmentConfig(), emit: (r) => emitVendorAuthzAudit(this.deps.fulfillmentDb, r), traceId },
      req.claim,
      'sheet:submit-return',
      { vndrId: sheet.vndrId, workQueue: sheet.workQueue },
    )
    if (!decision.allowed) throw new ForbiddenException()

    return ingestReturnSheet(this.deps.fulfillmentDb, req.claim, sheet, traceId)
  }
}
