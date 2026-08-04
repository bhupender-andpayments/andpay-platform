import { enqueue } from '@andpay/outbox'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { eventKey } from '@andpay/keys'
import type { TmsDb } from './db.js'
import { emitDemandFact } from './assignment.js'
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
}

// Damage-file ingest (D116). Matches an original asgn_ by (tenant, vpa), creates
// a NEW non-billable replacement referencing it (case_status Open, damage reason
// from the row, bank remarks), moves the original to replacement-raised, and
// emits both the linkage fact and the demand fact (ratified). Idempotent on the
// damage {file_id}|{row_no} via the replacement's source_event_id UNIQUE.
export async function ingestDamageRowWithinTx(
  tx: Tx,
  row: BankDamageRow,
  traceId: string,
): Promise<'replaced' | 'duplicate' | 'quarantined'> {
  const correlationId = `${row.fileId}|${row.rowNo}`
  let outcome: 'replaced' | 'duplicate' | 'quarantined' = 'quarantined'

  const matches = await tx.$queryRaw<OriginalRow[]>`
    SELECT id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
           bank_reference_code, bank_display_name, qr_value, vpa_value, soundbox, standee_count, sticker_count,
           contact_name, mobile
    FROM assignment
    WHERE bank_reference_code = ${row.tenantReference} AND vpa_value = ${row.vpaValue} AND replacement_of IS NULL
  `
  if (matches.length !== 1) {
    await tx.$executeRaw`
      INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
      VALUES (${row.fileId}, ${row.rowNo}, ${'redacted:bank_damage'}, ${matches.length === 0 ? 'no_match' : 'ambiguous_match'})
      ON CONFLICT (file_id, row_no) DO NOTHING
    `
    outcome = 'quarantined'
    return outcome
  }
  const o = matches[0]!

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
  const reasonMatches = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM damage_reason
    WHERE active = true AND LOWER(TRIM(label)) = LOWER(TRIM(${row.damageReason}))
  `
  if (reasonMatches.length === 0) {
    await tx.$executeRaw`
      INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
      VALUES (${row.fileId}, ${row.rowNo}, ${'redacted:bank_damage'}, ${'invalid_damage_reason'})
      ON CONFLICT (file_id, row_no) DO NOTHING
    `
    outcome = 'quarantined'
    return outcome
  }

  await enterWriteScope(tx, 'tms_write', o.program_id)

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
      demand_state, source_event_id, contact_name, mobile, updated_at
    ) VALUES (
      ${replUuid}::uuid, ${o.merchant_id}::uuid, ${o.program_id}::uuid, ${o.tenant_id}::uuid,
      ${o.merchant_display_name}, ${o.merchant_legal_name}, ${o.merchant_mcc},
      ${o.bank_reference_code}, ${o.bank_display_name}, ${row.shipToAddress},
      ${o.qr_value}, ${o.vpa_value}, ${o.soundbox}, ${o.standee_count}, ${o.sticker_count},
      ${false}, ${o.id}::uuid, ${row.damageReason}, ${row.bankRemarks}, ${'Open'},
      ${'received'}, ${correlationId}, ${o.contact_name}, ${o.mobile}, now()
    )
    ON CONFLICT (source_event_id) DO NOTHING
    RETURNING id
  `
  if (won.length === 0) {
    outcome = 'duplicate'
    return outcome
  }

  const replId = fromUuid('asgn', replUuid)
  // linkage fact
  await enqueue(tx, {
    aggregateType: 'assignment',
    aggregateId: replId,
    eventType: TMS_REPLACEMENT_RAISED_TOPIC,
    partitionKey: replId,
    payload: replacementRaisedFactEnvelope({
      payload: { asgnId: replId, replacedAsgnId: fromUuid('asgn', o.id), damageReason: row.damageReason, bankRemarks: row.bankRemarks },
      dedupKey: eventKey(correlationId, 'tms.assignment.replacement_raised'),
      traceId,
    }),
  })
  // demand fact + pooled-for-fulfillment (billable=false already stored)
  await emitDemandFact(tx, replUuid, correlationId, traceId)
  // the original moves to replacement-raised
  await tx.$executeRaw`UPDATE assignment SET demand_state = 'replacement-raised', updated_at = now() WHERE id = ${o.id}::uuid`
  outcome = 'replaced'
  return outcome
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
