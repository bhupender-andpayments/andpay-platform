import { enqueue } from '@andpay/outbox'
import type { TmsDb } from './db.js'
import { rowFactEnvelope, ROW_FACT_TYPE } from './row-fact.js'
import { validateQrVpaFormat, type Tx } from './internal.js'
import { enterWriteRole } from './write-context.js'

export interface BankRequestRow {
  fileId: string
  rowNo: number
  bankMerchantReference: string
  displayName: string
  legalName: string
  mcc: string
  registeredAddress: string
  bankReferenceCode: string
  productType: string
  vpaValue: string
  qrValue: string
  soundbox: boolean
  standeeCount: number
  stickerCount: number
  shipToAddress: string
  // spec 06a: mandatory recipient contact columns (BRD FR-01b). A row missing
  // either is a row-level rejection (S8 reject path); they never reach the row
  // fact (S7/S5), only pending_row and the assignment snapshot.
  contactName: string
  mobile: string
  // Phase 3 Task 4: the mandatory bank-file Branch Code (BRD 5.1b). Like the
  // recipient contact, it is TMS-local snapshot data (not an identity key: the
  // tenant already keys on bank_reference_code), so it never reaches the row
  // fact, only pending_row and the assignment snapshot. A row missing it is a
  // row-level rejection, mirroring contactName/mobile.
  branchCode: string
  // The bank PARTNER that owns the aggregators, when the file declares one.
  // Absent means the row's own bankReferenceCode is the tenant.
  tenantReference?: string
  vpaHint?: string
}

// The row-level reject reason (S8 row validation), extracted so BOTH the
// ingest path below and the preview surface (services/tms/src/ops.ts
// previewBankFile) run the SAME rules with no duplication: format-only QR/VPA
// (D117) plus the FR-01b mandatory recipient contact/mobile (spec 06a). An
// empty contact_name or mobile counts as missing. An empty branch_code counts
// as missing too (Phase 3 Task 4, BRD 5.1b mandatory). `null` means the row passes.
//
// P-A / D2: `missing_recipient_contact` covered TWO columns under one code, so
// even first-error-wins could not name which column failed. It is now split into
// `missing_contact_name` and `missing_mobile`. D2's note that "the Email half
// should go away entirely" does not apply here: this check never covered Email
// (Email is not on BankRequestRow at all), it covered contact name and mobile,
// and D3 requires BOTH. So this is a pure split, nothing dropped.
//
// P-A: these are the SOURCE-AGNOSTIC rules only. See the note below on why the
// D3 per-column patterns are deliberately NOT here.
export type RequestRowRejectReason =
  | 'invalid_qr_vpa_format'
  | 'missing_display_name'
  | 'missing_legal_name'
  | 'missing_registered_address'
  | 'missing_contact_name'
  | 'missing_mobile'
  | 'missing_branch_code'
  | 'invalid_standee_count'
  | 'invalid_sticker_count'

// WHY THE D3 PATTERNS ARE NOT VALIDATED HERE (P-A, 2026-08-07).
//
// D3 tabulates per-column patterns (Mobile exactly 10 digits, Category Code 3 or
// 4 digits, Bank and Branch code numeric). Every one of those was measured
// against ONE bank's file, the 360-row GSCB export. This function is the
// SOURCE-AGNOSTIC validator: every file from every bank passes through it,
// including canonical-profile files that no Annexure B profile ever reshaped.
//
// Enforcing GSCB's dialect here would reject a second bank's legitimate data.
// Concretely, `bankReferenceCode: 'HDFC'` and `branchCode: 'BR-001'` are
// alphanumeric and would be rejected on arrival, and a `+91` prefixed mobile
// would fail a bare-10-digit rule. GSCB happens to ship numeric aggregator codes
// (3, 18, 1523 ... 8606); that is a fact about GSCB, not about bank files.
//
// The precedent is already set in this repo. The Soundbox `Y`/`N` defect was
// fixed in the Annexure B profile "that knows the dialect rather than by
// widening parseBoolean for every future format". Dialect belongs with the
// profile. bank-source-profile.ts:33 currently states a profile only reshapes
// and has no reject channel, so giving it one is a design change, not a drive-by.
// AWAITING A RULING from Bhupender; see BANK_FILE_DECISIONS_2026-08-07.md.
//
// What IS here is what holds for ANY source: a value that is structurally
// impossible rather than merely differently formatted.

// Required, non-negative INTEGER. Zero is a legitimate quantity (a merchant
// wanting no standee), so the floor is 0 and not 1. NaN is what a non-numeric
// cell parses to upstream, and it must never reach a print instruction.
// Source-agnostic: no bank can want minus one sticker.
function isCollateralCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

// Trimmed, because a whitespace-only cell is empty to the human who has to read
// the printed artifact, and these three values are DRAWN onto standees and
// stickers. Source-agnostic: no bank can want a blank merchant name printed.
function isBlank(value: string): boolean {
  return value.trim() === ''
}

export function requestRowRejectReason(row: BankRequestRow): RequestRowRejectReason | null {
  if (!validateQrVpaFormat(row.qrValue, row.vpaValue)) return 'invalid_qr_vpa_format'
  if (isBlank(row.displayName)) return 'missing_display_name'
  if (isBlank(row.legalName)) return 'missing_legal_name'
  if (isBlank(row.registeredAddress)) return 'missing_registered_address'
  if (!row.contactName) return 'missing_contact_name'
  if (!row.mobile) return 'missing_mobile'
  if (!row.branchCode) return 'missing_branch_code'
  if (!isCollateralCount(row.standeeCount)) return 'invalid_standee_count'
  if (!isCollateralCount(row.stickerCount)) return 'invalid_sticker_count'
  return null
}

// Ingest one bank request-file row (S8-untrusted, D116). Validates FORMAT only
// (D117). On accept: stashes the TMS-owned slice in pending_row and emits
// fct.tms.bank_file_row.v1 (identity slice + vpaHint only, S7/S5) in the same
// transaction (E1). Idempotent on {file_id}|{row_no} via the pending_row UNIQUE.
//
// Injected-tx variant (spec 10c Task 4): the original opened two SEPARATE
// db.$transaction calls, one for the reject sub-path and one for the accept
// sub-path. For a single input row only ONE of the two sub-paths ever executes
// (the reject branch returns before the accept branch's code is reached), so
// collapsing both into the ONE caller-supplied tx below is behavior-equivalent
// per call: whichever sub-path runs, it runs alone, in one transaction, same as
// before. This lets a later ops API run the effect plus the E6 inbox dedup and
// a server-resolved write scope together in a single transaction.
export async function ingestRequestRowWithinTx(
  tx: Tx,
  row: BankRequestRow,
  traceId: string,
): Promise<'accepted' | 'duplicate' | 'quarantined'> {
  const correlationId = `${row.fileId}|${row.rowNo}`

  // S8 row-level validation (the SAME rules the preview surface runs): a
  // failure quarantines the row via the reject/report path.
  const rejectReason = requestRowRejectReason(row)
  if (rejectReason) {
    let quarantined = false
    const won = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
      VALUES (${row.fileId}, ${row.rowNo}, ${'redacted:bank_request'}, ${rejectReason})
      ON CONFLICT (file_id, row_no) DO NOTHING
      RETURNING id
    `
    if (won.length === 0) return 'duplicate' // already quarantined: no second counter bump (check 3)
    quarantined = true
    await tx.$executeRaw`
      INSERT INTO ingest_file (file_id, source, tenant_reference, row_total, row_rejected, status)
      VALUES (${row.fileId}, ${'bank_request'}, ${row.bankReferenceCode}, 1, 1, ${'received'})
      ON CONFLICT (file_id) DO UPDATE SET row_total = ingest_file.row_total + 1, row_rejected = ingest_file.row_rejected + 1
    `
    return quarantined ? 'quarantined' : 'duplicate'
  }

  let outcome: 'accepted' | 'duplicate' = 'duplicate'
  const won = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO pending_row
      (correlation_id, tenant_reference, soundbox, standee_count, sticker_count, qr_value, vpa_value, ship_to_address, contact_name, mobile, branch_code, status)
    VALUES
      (${correlationId}, ${row.bankReferenceCode}, ${row.soundbox}, ${row.standeeCount}, ${row.stickerCount}, ${row.qrValue}, ${row.vpaValue}, ${row.shipToAddress}, ${row.contactName}, ${row.mobile}, ${row.branchCode}, ${'awaiting-identity'})
    ON CONFLICT (correlation_id) DO NOTHING
    RETURNING id
  `
  if (won.length === 0) return outcome // already ingested: no second fact (check 3)
  outcome = 'accepted'

  await enqueue(tx, {
    aggregateType: 'bank_file_row',
    aggregateId: correlationId,
    eventType: ROW_FACT_TYPE,
    partitionKey: `${row.bankReferenceCode}|${row.bankMerchantReference}`,
    payload: rowFactEnvelope({
      payload: {
        bankMerchantReference: row.bankMerchantReference,
        displayName: row.displayName,
        legalName: row.legalName,
        mcc: row.mcc,
        registeredAddress: row.registeredAddress,
        bankReferenceCode: row.bankReferenceCode,
        ...(row.tenantReference === undefined ? {} : { tenantReference: row.tenantReference }),
        productType: row.productType,
        vpaHint: row.vpaHint,
      },
      dedupKey: correlationId,
      traceId,
      subject: `${row.bankReferenceCode}|${row.bankMerchantReference}`,
    }),
  })

  await tx.$executeRaw`
    INSERT INTO ingest_file (file_id, source, tenant_reference, row_total, row_accepted, status)
    VALUES (${row.fileId}, ${'bank_request'}, ${row.bankReferenceCode}, 1, 1, ${'received'})
    ON CONFLICT (file_id) DO UPDATE SET row_total = ingest_file.row_total + 1, row_accepted = ingest_file.row_accepted + 1
  `
  return outcome
}

// Non-ops entry point (spec 10d Task 3, M-role only: no program-scoped write
// exists in this body). Enters the role FIRST so every write in the shared
// WithinTx body -- whichever sub-path runs, quarantine_row or pending_row +
// ingest_file -- runs under tms_write instead of the table owner.
export async function ingestRequestRow(
  db: TmsDb,
  row: BankRequestRow,
  traceId: string,
): Promise<'accepted' | 'duplicate' | 'quarantined'> {
  return db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'tms_write')
    return ingestRequestRowWithinTx(tx, row, traceId)
  })
}
