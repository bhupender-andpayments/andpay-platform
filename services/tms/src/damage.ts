import { enqueue } from '@andpay/outbox'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { eventKey } from '@andpay/keys'
import type { TmsDb } from './db.js'
import { emitDemandFact, type DispatchGroup } from './assignment.js'
import { activeDamageResolution } from './damage-resolution.js'
import { replacementRaisedFactEnvelope, TMS_REPLACEMENT_RAISED_TOPIC } from './events.js'
import { type Tx } from './internal.js'
import { enterWriteScope, enterWriteRole } from './write-context.js'

export interface BankDamageRow {
  fileId: string
  rowNo: number
  tenantReference: string
  vpaValue: string
  damageReason: string
  bankRemarks: string
  shipToAddress: string
  // Per-row items to replace, as a SINGLE optional group so the all-or-nothing
  // invariant is unrepresentable: either the row supplies the full item trio
  // (authoritative) or it omits `items` and the resolution strategy decides.
  //
  // D-20 (T6.2) removed the columns that fed this from the CANONICAL mapping, so
  // nothing populates it today. The field survives because a source profile that
  // genuinely carries per-item quantities must keep resolving as it always did,
  // and because WHICH items a damage replaces is O-1's open question: a future
  // answer may well want this input back. Contrast deliveryStatus below, which
  // is gone outright.
  items?: { soundbox: boolean; standeeCount: number; stickerCount: number }
}

// The replacement case-status lifecycle values.
//
// D-24 (T6.2): a case now ALWAYS opens at 'Open', and the file's old Delivery
// Status column that used to seed it is gone from the row shape entirely, not
// merely unmapped. That is a different call from the one made about `items`
// above, and deliberately: which items are damaged is something the bank can
// legitimately know and tell us, while where a replacement has got to is
// something only this platform watches. A file that opened a case already
// Closed was asserting a lifecycle nobody here had observed.
export const CASE_STATUS_VALUES = ['Open', 'In-Progress', 'Closed'] as const
export type CaseStatus = (typeof CASE_STATUS_VALUES)[number]

const INITIAL_CASE_STATUS: CaseStatus = 'Open'

/**
 * Read a caller-supplied case status against the closed vocabulary.
 *
 * D-24 (T6.5) spells the middle state "In Progress" and this schema stores it
 * "In-Progress", so the comparison is normalized on whitespace and case rather
 * than making every caller learn which spelling this particular column chose.
 * Returns undefined for anything outside the vocabulary; a caller decides
 * whether that is a client error or a silent skip.
 */
export function normalizeCaseStatus(raw: string): CaseStatus | undefined {
  const norm = raw.trim().toLowerCase().replace(/\s+/g, '-')
  return CASE_STATUS_VALUES.find((v) => v.toLowerCase() === norm)
}

interface OriginalRow {
  id: string
  merchant_id: string
  program_id: string
  tenant_id: string
  merchant_display_name: string
  merchant_legal_name: string
  merchant_mcc: string
  bank_reference_code: string
  bank_display_name: string
  qr_value: string
  vpa_value: string
  soundbox: boolean
  standee_count: number
  sticker_count: number
  contact_name: string | null
  mobile: string | null
  branch_code: string | null
  source_event_id: string
  dispatch_group: DispatchGroup
}

// Damage-file ingest (D116). Matches at the REQUEST grain: (bank_reference_code,
// vpa) must resolve to originals sharing exactly one source_event_id (a request
// is now one or two dispatch-group rows, W-5). Mints one non-billable
// replacement PER damaged dispatch group (case_status Open, damage reason from
// the row, bank remarks), each referencing its own same-group original, moves
// each replaced original to replacement-raised, and emits both the linkage fact
// and the demand fact (ratified) for each. Idempotent per group on
// (source_event_id, dispatch_group) UNIQUE.
export async function ingestDamageRowWithinTx(
  tx: Tx,
  row: BankDamageRow,
  traceId: string,
): Promise<'replaced' | 'duplicate' | 'quarantined'> {
  const correlationId = `${row.fileId}|${row.rowNo}`

  const matches = await tx.$queryRaw<OriginalRow[]>`
    SELECT id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
           bank_reference_code, bank_display_name, qr_value, vpa_value, soundbox, standee_count, sticker_count,
           contact_name, mobile, branch_code, source_event_id, dispatch_group
    FROM assignment
    WHERE bank_reference_code = ${row.tenantReference} AND vpa_value = ${row.vpaValue} AND replacement_of IS NULL
  `
  // W-5: match at the REQUEST grain. A request is now 1 or 2 dispatch groups sharing one
  // source_event_id, so "exactly one match" becomes "exactly one request".
  const requestKeys = new Set(matches.map((m) => m.source_event_id))
  if (requestKeys.size !== 1) {
    // quarantine exactly as before: no_match when zero, ambiguous_match when
    // several REQUESTS collide on (bank_reference_code, vpa).
    await tx.$executeRaw`
      INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
      VALUES (${row.fileId}, ${row.rowNo}, ${'redacted:bank_damage'}, ${requestKeys.size === 0 ? 'no_match' : 'ambiguous_match'})
      ON CONFLICT (file_id, row_no) DO NOTHING
    `
    return 'quarantined'
  }

  // Phase 3 Task 1 (BRD FR-08, FR-11): validate row.damageReason against the
  // ACTIVE damage_reason master, AFTER the (bank_ref, vpa) match above, never
  // before. Checking the match first preserves the existing no_match/
  // ambiguous_match quarantine behavior exactly as it was (a row with an
  // unrecognized reason AND no/ambiguous original match still quarantines
  // with no_match/ambiguous_match, not invalid_damage_reason); only a row that
  // DID resolve to exactly one original then also has its reason checked.
  // Match is by label, case- and whitespace-insensitive (LOWER(TRIM(...))):
  // the bank file supplies free-text human-readable reasons (e.g. "battery
  // issue"), not the admin-facing stable `code`. An inactive (deactivated)
  // reason does not match here either (`active = true`), so deactivating a
  // reason quarantines any later row still using it, same as an unknown one.
  // Fix-round 1 (review finding, Important): the normalized-unique index on
  // damage_reason.label (migration 20260804165617) means this can no longer
  // find MORE than one row for any input going forward, but the check still
  // branches on `!== 1`, not just `=== 0`, as defense-in-depth (mirrors the
  // (bank_ref, vpa) match block above, which does the same): if the
  // normalized-unique invariant were ever violated (a manual DB edit, a
  // future migration regression), an ambiguous match must quarantine, never
  // silently pick one row.
  const reasonMatches = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM damage_reason
    WHERE active = true AND LOWER(TRIM(label)) = LOWER(TRIM(${row.damageReason}))
  `
  if (reasonMatches.length !== 1) {
    await tx.$executeRaw`
      INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
      VALUES (${row.fileId}, ${row.rowNo}, ${'redacted:bank_damage'}, ${reasonMatches.length === 0 ? 'invalid_damage_reason' : 'ambiguous_damage_reason'})
      ON CONFLICT (file_id, row_no) DO NOTHING
    `
    return 'quarantined'
  }

  await enterWriteScope(tx, 'tms_write', matches[0]!.program_id)

  // THE O-1 DECISION POINT (T6.1). Which of the merchant's items this damage
  // replaces is the one open question the walkthrough did not answer, so it is
  // made in exactly one place (damage-resolution.ts) rather than inline here.
  // The strategy in force today is a faithful copy of what this code did before
  // the seam existed; when O-1 is answered, that module changes and this ingest
  // does not.
  //
  // A strategy that CANNOT decide holds the row rather than guessing, which is
  // the same posture this ingest already takes for a row it cannot match.
  const resolution = activeDamageResolution({
    originals: matches.map((m) => ({
      dispatchGroup: m.dispatch_group,
      soundbox: m.soundbox,
      standeeCount: m.standee_count,
      stickerCount: m.sticker_count,
    })),
    damageReason: row.damageReason,
    bankRemarks: row.bankRemarks,
    ...(row.items === undefined ? {} : { items: row.items }),
  })
  if (resolution.kind === 'quarantine') {
    await tx.$executeRaw`
      INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
      VALUES (${row.fileId}, ${row.rowNo}, ${'redacted:bank_damage'}, ${resolution.reasonCode})
      ON CONFLICT (file_id, row_no) DO NOTHING
    `
    return 'quarantined'
  }
  const effectiveGroups = resolution.groups

  // Which original row anchors each replacement dispatch group. New-shape
  // requests have at most one row per dispatch group. A LEGACY combined row
  // (pre-split) is the anchor for every dispatch group it can support:
  // soundbox if it ordered one, collateral if it carried counts (its
  // backfilled dispatch_group value is dominant-group cosmetic and
  // deliberately NOT trusted here; the product columns are the truth).
  const soundboxOriginal =
    matches.find((m) => m.dispatch_group === 'SOUNDBOX' && m.soundbox) ?? matches.find((m) => m.soundbox)
  const collateralOriginal =
    matches.find((m) => m.dispatch_group === 'COLLATERAL') ??
    matches.find((m) => m.standee_count > 0 || m.sticker_count > 0)

  // The resolution named a group this request cannot anchor. Held, never
  // minted, and checked for EVERY group before any insert so a hold never
  // leaves a partial mint.
  //
  // D-21 asked for the "collateral must exist" VALIDATION to go, and T6.2 is
  // what removed it: the file's item columns were the only way a damage row
  // could name a group the request never had, so with those unmapped, standee
  // damage for a merchant who never ordered a soundbox now resolves to the
  // collateral it did order and passes. What remains here is not that
  // validation. It is a structural guard on the MINT, and it is what stops a
  // future O-1 strategy (reason-implies-group can name SOUNDBOX for a
  // collateral-only merchant) from dereferencing an anchor that is not there.
  // Removing it in D-21's name would be removing a safety net and calling it
  // compliance.
  for (const groupSpec of effectiveGroups) {
    const anchor = groupSpec.group === 'SOUNDBOX' ? soundboxOriginal : collateralOriginal
    if (anchor === undefined) {
      await tx.$executeRaw`
        INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
        VALUES (${row.fileId}, ${row.rowNo}, ${'redacted:bank_damage'}, ${'no_match'})
        ON CONFLICT (file_id, row_no) DO NOTHING
      `
      return 'quarantined'
    }
  }

  const initialCaseStatus = INITIAL_CASE_STATUS

  let anyWon = false
  for (const groupSpec of effectiveGroups) {
    const anchor = (groupSpec.group === 'SOUNDBOX' ? soundboxOriginal : collateralOriginal)!
    const replUuid = toUuid(newId('asgn'))
    // updated_at is @updatedAt in the Prisma schema, which is client-API
    // middleware only (it does not run for $queryRaw/$executeRaw) and the
    // column has no DB-level DEFAULT, so it must be set explicitly here, same
    // as createAssignmentFromEnrollment's INSERT in assignment.ts.
    const won = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO assignment (
        id, merchant_id, program_id, tenant_id,
        merchant_display_name, merchant_legal_name, merchant_mcc,
        bank_reference_code, bank_display_name, ship_to_address,
        qr_value, vpa_value, soundbox, standee_count, sticker_count,
        billable, replacement_of, damage_reason, bank_remarks, case_status,
        demand_state, source_event_id, contact_name, mobile, branch_code, dispatch_group, updated_at
      ) VALUES (
        ${replUuid}::uuid, ${anchor.merchant_id}::uuid, ${anchor.program_id}::uuid, ${anchor.tenant_id}::uuid,
        ${anchor.merchant_display_name}, ${anchor.merchant_legal_name}, ${anchor.merchant_mcc},
        ${anchor.bank_reference_code}, ${anchor.bank_display_name}, ${row.shipToAddress},
        ${anchor.qr_value}, ${anchor.vpa_value}, ${groupSpec.soundbox}, ${groupSpec.standeeCount}, ${groupSpec.stickerCount},
        ${false}, ${anchor.id}::uuid, ${row.damageReason}, ${row.bankRemarks}, ${initialCaseStatus},
        ${'received'}, ${correlationId}, ${anchor.contact_name}, ${anchor.mobile}, ${anchor.branch_code}, ${groupSpec.group}, now()
      )
      ON CONFLICT (source_event_id, dispatch_group) DO NOTHING
      RETURNING id
    `
    if (won.length === 0) continue // this dispatch group's replacement already exists (idempotent)
    anyWon = true

    const replId = fromUuid('asgn', replUuid)
    // linkage fact. Dedup key is PER GROUP: two groups from the same row share
    // correlationId, so without the group suffix the second group's fact
    // would carry the same dedupKey as the first and a downstream consumer's
    // inbox would silently drop it as already-processed.
    await enqueue(tx, {
      aggregateType: 'assignment',
      aggregateId: replId,
      eventType: TMS_REPLACEMENT_RAISED_TOPIC,
      partitionKey: replId,
      payload: replacementRaisedFactEnvelope({
        payload: { asgnId: replId, replacedAsgnId: fromUuid('asgn', anchor.id), damageReason: row.damageReason, bankRemarks: row.bankRemarks },
        dedupKey: eventKey(`${correlationId}|${groupSpec.group}`, 'tms.assignment.replacement_raised'),
        traceId,
      }),
    })
    // demand fact + pooled-for-fulfillment (billable=false already stored).
    // envId is PER GROUP for the same reason as the linkage fact above.
    await emitDemandFact(tx, replUuid, `${correlationId}|${groupSpec.group}`, traceId)
    // this group's original moves to replacement-raised
    await tx.$executeRaw`UPDATE assignment SET demand_state = 'replacement-raised', updated_at = now() WHERE id = ${anchor.id}::uuid`
  }

  return anyWon ? 'replaced' : 'duplicate'
}

// Non-ops entry point (spec 10d Task 3): enters the role FIRST, before
// delegating to the shared WithinTx body, so the quarantine (no-match) path
// -- which writes quarantine_row (M-role) BEFORE any program is known, and
// may return before ingestDamageRowWithinTx ever resolves a program_id at all
// -- also runs under tms_write instead of the table owner. The matched
// (replaced) path's own enterWriteScope call inside ingestDamageRowWithinTx
// then re-enters the role together with the resolved program_id; re-setting
// SET LOCAL ROLE to the same role mid-transaction is a harmless no-op (the
// identical pattern already ratified for tms commitDamageFile, spec 10c).
export async function ingestDamageRow(
  db: TmsDb,
  row: BankDamageRow,
  traceId: string,
): Promise<'replaced' | 'duplicate' | 'quarantined'> {
  return db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'tms_write')
    return ingestDamageRowWithinTx(tx, row, traceId)
  })
}
