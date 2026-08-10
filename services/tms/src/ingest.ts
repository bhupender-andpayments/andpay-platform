import { enqueue } from '@andpay/outbox'
import { fromUuid } from '@andpay/ids'
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
// P-A: the source-agnostic rules PLUS the D3 per-column patterns.
//
// `duplicate_vpa_soundbox` (ruling 2026-08-10) is the ONE member that is not a
// format rule, and it is deliberately in this union rather than beside it: it
// is a row-level reject reason, it lands in quarantine_row.reason_code like
// every other member, and the ops portal renders it from the same list. It is
// NOT produced by requestRowRejectReason below, which stays pure and DB-free
// (that purity is exactly why preview and commit can share it); the duplicate
// gate needs a read, so it is decided by seedKnownVpaOriginals plus
// duplicateVpaVerdicts and applied by ingestRequestRowWithinTx.
//
// NOTE for whoever edits this union next: test/reject_reason_parity.test.ts
// compares it TEXTUALLY against the hand-kept copy in
// apps/ops-portal/src/api/endpoints.ts and slices the declaration at the first
// BLANK LINE. Keep the members in one unbroken run of lines, and add the same
// spelling to the portal union in the same change.
export type RequestRowRejectReason =
  | 'invalid_qr_vpa_format'
  | 'missing_display_name'
  | 'missing_legal_name'
  | 'missing_registered_address'
  | 'missing_contact_name'
  | 'missing_mobile'
  | 'invalid_mobile_format'
  | 'invalid_category_code_format'
  | 'invalid_bank_code_format'
  | 'missing_branch_code'
  | 'invalid_branch_code_format'
  | 'invalid_standee_count'
  | 'invalid_sticker_count'
  | 'duplicate_vpa_soundbox'

// D11 RULED (Bhupender, 2026-08-07): GSCB is the ONLY tenant in scope, so its
// dialect IS the platform's dialect and the D3 patterns are enforced right here,
// globally, rather than being pushed into the source profile.
//
// THE COST IS DELIBERATE AND IS RECORDED SO IT IS NOT REDISCOVERED THE HARD WAY.
// Every pattern below was measured against ONE bank's file. A second bank
// shipping alphanumeric codes ('HDFC', 'BR-001') or a '+91' prefixed mobile will
// be REJECTED ROW BY ROW at ingest, and the rejection will look like the bank's
// fault rather than ours. The repo's own fixtures used exactly those shapes
// before this change, which is how concrete the risk is.
//
// SO WHEN A SECOND PARTNER ONBOARDS, THIS IS THE FIRST THING TO MOVE, and the
// destination is already known: the Annexure B source profile (D8), which is
// where the Soundbox Y/N dialect fix went for this same reason. That is option
// D11a in BANK_FILE_DECISIONS_2026-08-07.md, and the only work it needs is a
// reject channel on BankSourceProfile, which today only reshapes.

// D3: exactly 10 digits. 360 of 360 real rows comply, so Annexure B's 9-digit
// sample is simply wrong. Digits ONLY, so a separator or a letter-for-digit typo
// (O for 0) is a rejection rather than a silently mangled contact number.
const MOBILE_FORMAT = /^\d{10}$/

// D3: BOTH 3 and 4 digits are valid and are stored AS GIVEN. The real file
// carries 310 four-digit and 50 three-digit codes, and Bhupender ruled
// explicitly that a 3-digit code is NOT padded to 4. Validation therefore only
// bounds the shape; it never rewrites the value.
const CATEGORY_CODE_FORMAT = /^\d{3,4}$/

// D3: numeric, VARIABLE length, for both. One real file carries 19 distinct bank
// codes of 1, 2 and 4 digits (3, 18, 1523 ... 8606) and branch codes of 1 to 4
// digits, so a fixed width would reject real data. Length is deliberately
// unbounded: the evidence constrains the alphabet, not the width.
const NUMERIC_CODE_FORMAT = /^\d+$/

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
  if (!MOBILE_FORMAT.test(row.mobile)) return 'invalid_mobile_format'
  if (!CATEGORY_CODE_FORMAT.test(row.mcc)) return 'invalid_category_code_format'
  if (!NUMERIC_CODE_FORMAT.test(row.bankReferenceCode)) return 'invalid_bank_code_format'
  if (!row.branchCode) return 'missing_branch_code'
  if (!NUMERIC_CODE_FORMAT.test(row.branchCode)) return 'invalid_branch_code_format'
  if (!isCollateralCount(row.standeeCount)) return 'invalid_standee_count'
  if (!isCollateralCount(row.stickerCount)) return 'invalid_sticker_count'
  return null
}

// ---------------------------------------------------------------------------
// The soundbox duplicate-VPA gate (ruling 2026-08-10).
//
// D-2 read BRD 5.1b as "a flag, never a gate", and for a sticker/standee row it
// still is. For a SOUNDBOX row it is now a gate: asking for a second soundbox on
// a VPA we already serve is the case an operator has to look at BEFORE a device
// ships, not after, so the row is quarantined with `duplicate_vpa_soundbox` and
// the quarantine record NAMES the original.
//
// What is NOT gated, deliberately: the same merchant ordering with a DIFFERENT
// VPA. Merchant identity is VPA-derived today (`v1:vpa:<lower(vpa)>`, the D1
// interim in bank-source-profile.ts), so a different VPA is a different merchant
// as far as this repo can tell, and holding it would hold a legitimate order on
// a guess.
// ---------------------------------------------------------------------------

/**
 * The record a held row collides with, as the operator needs to read it.
 *
 * `reference` is deliberately per-kind rather than one uniform id, because the
 * three originals are three different things and no single id spans them:
 *   - `assignment`  the original already became an order. The WIRE asgn id
 *                   (D-A: reads emit wire ids), never the raw uuid.
 *   - `pending_row` the original is ingested and awaiting identity. Its
 *                   correlation_id, which is `{file_id}|{row_no}`, so it names
 *                   the upload and the line inside it.
 *   - `file_row`    the original is an EARLIER row of the same file. The row
 *                   number as a string, which also works in preview, where no
 *                   real fileId exists yet.
 *
 * `merchantDisplayName` is null when the original carries no name to show:
 * pending_row has no display-name column at all (see schema.prisma), and a
 * file_row original may have an empty one.
 */
export interface DuplicateVpaOriginal {
  kind: 'assignment' | 'pending_row' | 'file_row'
  reference: string
  merchantDisplayName: string | null
}

// The VPA key. Trimmed and lowercased because merchant identity is
// `v1:vpa:<lower(vpa)>` (D1 interim), so two casings of one VPA are ONE
// merchant, and a gate that missed that would be trivially defeated by an
// upper-case letter in the bank's export.
export function vpaKey(vpaValue: string): string {
  return vpaValue.trim().toLowerCase()
}

/**
 * Everything TMS ALREADY holds for the given VPAs, folded to one original per
 * VPA key. ONE read for the whole file rather than one per row (a 360-row GSCB
 * file would otherwise mean 720 scans), and it takes a `Tx` so both surfaces can
 * call it: the commit path inside its tms_write transaction, the preview path
 * inside its read-only tms_ops_read transaction.
 *
 * Both tables are TMS's own (no cross-context read, C4): `assignment` is a row
 * that already became an order, `pending_row` one still awaiting identity.
 *
 * FIRST-WINS by (kind, created_at): an `assignment` beats a `pending_row`
 * because it is the further-along record and the one an operator can actually
 * act on, and within a kind the EARLIEST row wins because the original is the
 * first sighting, not the most recent one. The ordering is done in SQL so the
 * fold is a plain first-wins insert and the precedence cannot drift between the
 * two call sites.
 *
 * Matches on lower(vpa_value), which is what the two functional indexes added in
 * 20260810100000_tms_duplicate_vpa_quarantine cover.
 *
 * `excludeSourceRef` is the `{file_id}|{row_no}` of a row that must not be
 * allowed to find ITSELF. It exists for the per-row lookup in
 * ingestRequestRowWithinTx, which runs AFTER earlier calls may have already
 * ingested this exact row: re-ingesting `file-1|1` would otherwise match the
 * pending_row (or the assignment) that the FIRST ingest of `file-1|1` created,
 * and a row would be held as a duplicate of itself instead of returning the
 * plain 'duplicate' its correlation_id dedup already means. Both tables carry
 * the same value under different names (`pending_row.correlation_id`,
 * `assignment.source_event_id`), so one argument covers both. The whole-file
 * callers pass nothing: they read the seed BEFORE writing any row, so no row of
 * the file is in it yet.
 */
export async function seedKnownVpaOriginals(
  tx: Tx,
  vpas: readonly string[],
  excludeSourceRef: string | null = null,
): Promise<Map<string, DuplicateVpaOriginal>> {
  const found = new Map<string, DuplicateVpaOriginal>()
  const keys = [...new Set(vpas.map(vpaKey).filter((k) => k !== ''))]
  if (keys.length === 0) return found

  // IS DISTINCT FROM rather than <>, so a null exclusion excludes nothing: both
  // columns are NOT NULL, and `x IS DISTINCT FROM NULL` is true for every x.
  const rows = await tx.$queryRaw<{ kind: string; ref: string; display_name: string | null; vpa_key: string }[]>`
    SELECT 0 AS kind_rank, 'assignment' AS kind, id::text AS ref, merchant_display_name AS display_name,
           lower(vpa_value) AS vpa_key, created_at AS origin_created_at
      FROM assignment
      WHERE lower(vpa_value) = ANY(${keys}::text[]) AND source_event_id IS DISTINCT FROM ${excludeSourceRef}
    UNION ALL
    SELECT 1 AS kind_rank, 'pending_row' AS kind, correlation_id AS ref, NULL::text AS display_name,
           lower(vpa_value) AS vpa_key, created_at AS origin_created_at
      FROM pending_row
      WHERE lower(vpa_value) = ANY(${keys}::text[]) AND correlation_id IS DISTINCT FROM ${excludeSourceRef}
    ORDER BY kind_rank ASC, origin_created_at ASC
  `
  for (const r of rows) {
    if (found.has(r.vpa_key)) continue
    found.set(
      r.vpa_key,
      r.kind === 'assignment'
        ? { kind: 'assignment', reference: fromUuid('asgn', r.ref), merchantDisplayName: r.display_name }
        : { kind: 'pending_row', reference: r.ref, merchantDisplayName: null },
    )
  }
  return found
}

/**
 * The verdict for every row of one file, keyed by rowNo. PURE and deterministic:
 * given the same rows and the same seed it returns the same answer, which is
 * what lets PREVIEW show exactly the verdict COMMIT will reach.
 *
 * Walks in FILE ORDER, so "the original" is always the earlier row. Every row's
 * VPA seeds the rows after it REGARDLESS of that row's own verdict, which is the
 * same walk the D-2 duplicateVpa counter already does: a held row is still a
 * sighting of that VPA, and pretending otherwise would let a third occurrence
 * point at a row that was itself held.
 *
 * A verdict is produced ONLY for a soundbox row. A sticker/standee row still
 * seeds (so a soundbox row after it is correctly held), but is never itself
 * held: D-2's flag-never-gate reading stands for it untouched.
 *
 * The FIRST occurrence of a VPA is never a duplicate, by construction: it is the
 * one that does the seeding.
 */
export function duplicateVpaVerdicts(
  rows: readonly BankRequestRow[],
  seed: ReadonlyMap<string, DuplicateVpaOriginal>,
): Map<number, DuplicateVpaOriginal> {
  const seen = new Map<string, DuplicateVpaOriginal>(seed)
  const verdicts = new Map<number, DuplicateVpaOriginal>()
  for (const row of rows) {
    const key = vpaKey(row.vpaValue)
    // An empty VPA is not an identity, so it can neither collide nor seed. Such
    // a row is rejected by requestRowRejectReason (invalid_qr_vpa_format) long
    // before this verdict would be consulted.
    if (key === '') continue
    const original = seen.get(key)
    if (original === undefined) {
      seen.set(key, {
        kind: 'file_row',
        reference: String(row.rowNo),
        merchantDisplayName: row.displayName.trim() === '' ? null : row.displayName,
      })
      continue
    }
    if (row.soundbox) verdicts.set(row.rowNo, original)
  }
  return verdicts
}

// The one quarantine INSERT, extracted so BOTH reject paths (a format failure
// and a soundbox duplicate-VPA hold) write the identical record and the
// `ingest_file.row_rejected` bump cannot drift between them. Behaviour is
// unchanged from the inline version it replaces: the same
// `ON CONFLICT (file_id, row_no) DO NOTHING` dedup, so a re-quarantine of the
// same (file, row) returns 'duplicate' and bumps NO counter a second time
// (check 3), and the same ingest_file upsert.
//
// `duplicateOf` is the only detail any reason carries today; null writes SQL
// NULL rather than an empty object, so "no detail" stays distinguishable from
// "detail with nothing in it".
async function quarantineRowWithinTx(
  tx: Tx,
  row: BankRequestRow,
  reasonCode: RequestRowRejectReason,
  duplicateOf: DuplicateVpaOriginal | null,
): Promise<'quarantined' | 'duplicate'> {
  const detail = duplicateOf === null ? null : JSON.stringify({ duplicateOf })
  const won = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code, detail)
    VALUES (${row.fileId}, ${row.rowNo}, ${'redacted:bank_request'}, ${reasonCode}, ${detail}::jsonb)
    ON CONFLICT (file_id, row_no) DO NOTHING
    RETURNING id
  `
  if (won.length === 0) return 'duplicate' // already quarantined: no second counter bump (check 3)
  await tx.$executeRaw`
    INSERT INTO ingest_file (file_id, source, tenant_reference, row_total, row_rejected, status)
    VALUES (${row.fileId}, ${'bank_request'}, ${row.bankReferenceCode}, 1, 1, ${'received'})
    ON CONFLICT (file_id) DO UPDATE SET row_total = ingest_file.row_total + 1, row_rejected = ingest_file.row_rejected + 1
  `
  return 'quarantined'
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
//
// `duplicateVpaOriginal` (ruling 2026-08-10) has THREE meanings, and the
// difference between the first two matters:
//   - `undefined`  the caller did not precompute, so look this ONE row up here.
//                  This is what makes resolveQuarantineRow work for free: an
//                  operator re-submitting a corrected row that is STILL a
//                  soundbox duplicate re-quarantines with a named original,
//                  without that route needing to know the gate exists.
//   - `null`       the caller DID precompute and this row is not a duplicate.
//                  No lookup, no read.
//   - an object    precomputed and it IS a duplicate: quarantine and name it.
export async function ingestRequestRowWithinTx(
  tx: Tx,
  row: BankRequestRow,
  traceId: string,
  duplicateVpaOriginal?: DuplicateVpaOriginal | null,
): Promise<'accepted' | 'duplicate' | 'quarantined'> {
  const correlationId = `${row.fileId}|${row.rowNo}`

  // S8 row-level validation (the SAME rules the preview surface runs): a
  // failure quarantines the row via the reject/report path.
  //
  // FORMAT WINS FIRST, and that ordering is deliberate: first-error-wins is
  // preserved, so a duplicate row that ALSO has an empty contact name is
  // reported as missing_contact_name, which is the error the operator can
  // actually fix. The duplicate is still there after the fix and is caught on
  // the re-submission.
  const rejectReason = requestRowRejectReason(row)
  if (rejectReason) return quarantineRowWithinTx(tx, row, rejectReason, null)

  // The soundbox duplicate-VPA gate (ruling 2026-08-10), reached only by a
  // FORMAT-VALID row. A sticker/standee row (soundbox false) never enters here
  // at all: D-2's flag-never-gate reading is untouched for it.
  if (row.soundbox) {
    let original = duplicateVpaOriginal ?? null
    if (duplicateVpaOriginal === undefined) {
      // Excluding THIS row's own correlation id: a re-ingest of `file-1|1` must
      // still return the plain 'duplicate' its correlation_id dedup means, not
      // be held as a duplicate of the pending_row its own first ingest created.
      const seed = await seedKnownVpaOriginals(tx, [row.vpaValue], correlationId)
      original = seed.get(vpaKey(row.vpaValue)) ?? null
    }
    if (original !== null) return quarantineRowWithinTx(tx, row, 'duplicate_vpa_soundbox', original)
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
