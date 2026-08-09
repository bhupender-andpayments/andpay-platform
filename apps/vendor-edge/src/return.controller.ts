import { createHash, randomUUID } from 'node:crypto'
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
  ingestReturnSheet,
  loadFulfillmentConfig,
  emitVendorAuthzAudit,
  parseReturnWorkbook,
  type ReturnSheet,
  type ReturnSheetRowError,
} from '@andpay/fulfillment-service'
import { EdgeCredentialGuard } from './guard.js'
import { EDGE_DEPS, MAX_SHEET_BYTES, type EdgeDeps } from './deps.js'
import { parseReturnSheet, EdgeParseError } from './sheet-parse.js'
import type { EdgeRequest } from './request.js'

const RETURN_OPERATION = 'sheet:submit-return'

interface UploadedJson {
  buffer: Buffer
  originalname?: string
}

// Extension-based, matching how the device-inventory adapter decides. A file
// with no name or a .json name takes the original JSON path, so nothing that
// worked before changes.
function isWorkbook(file: UploadedJson | undefined): boolean {
  const name = (file?.originalname ?? '').toLowerCase()
  return name.endsWith('.xlsx') || name.endsWith('.csv')
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

    // D-4: the same route accepts the vendor's WORKBOOK as well as the JSON
    // sheet, chosen by file extension. One return surface, because the BRD says
    // "the return file" singular and a second route would mean a second
    // permission, a second audit path and two things to keep in step.
    //
    // The JSON path is untouched: the vendor portal parses csv client-side and
    // posts `<fileId>.json`, and that keeps working byte for byte.
    let sheet: ReturnSheet
    let invalidRows: ReturnSheetRowError[] = []
    try {
      if (isWorkbook(file)) {
        const parsed = await parseReturnWorkbook(new Uint8Array(file!.buffer), file!.originalname ?? '')
        if (parsed.structuralErrors.length > 0) {
          throw new EdgeParseError(parsed.structuralErrors.map((e) => e.message).join(' '))
        }
        invalidRows = parsed.invalidRows
        sheet = {
          // vndrId and workQueue are SERVER-DERIVED from the authenticated
          // claim, never read off the upload (D99, M7, S16). A workbook has
          // nowhere to declare them anyway, and deriving them means a vendor
          // cannot submit for anyone else by construction rather than by a
          // check. `wq` is absent on a class-7 claim, where the work-queue axis
          // is skipped; the portal's existing constant is reused so the two
          // paths agree.
          vndrId: req.claim.scope.vndr!,
          workQueue: req.claim.scope.wq ?? 'vendor-portal',
          // A CONTENT HASH, so file-level idempotency is automatic: re-sending
          // the identical workbook dedups on {vndrId}|{fileId}, while a
          // corrected file with one changed row is legitimately new. The JSON
          // path mints its fileId in the portal and keeps doing so.
          fileId: createHash('sha256').update(file!.buffer).digest('hex'),
          rows: parsed.validRows,
        }
      } else {
        sheet = parseUploadedReturnSheet(file)
      }
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

    const result = await ingestReturnSheet(this.deps.fulfillmentDb, req.claim, sheet, traceId)
    // Rows the WORKBOOK parser quarantined are reported alongside the ingest
    // result, so a partial file tells the operator which rows to resend rather
    // than looking like a clean success. Absent on the JSON path, which rejects
    // a bad row at parse time.
    return invalidRows.length > 0 ? { ...result, invalidRows } : result
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
