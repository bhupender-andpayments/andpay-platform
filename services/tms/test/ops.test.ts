import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import {
  previewBankFile,
  commitBankFile,
  commitDamageFile,
  resolveQuarantineRow,
  closeQuarantineRow,
  updateDamageCaseStatusOps,
  OpsClientError,
  BankFileParseError,
} from '../src/ops.js'
import { readQuarantineQueue, readDamageCases } from '../src/ops-read.js'
import { DEFAULT_REQUEST_COLUMN_MAPPING, DEFAULT_DAMAGE_COLUMN_MAPPING } from '../src/bank-file-adapter.js'
import type { BankRequestRow } from '../src/ingest.js'

const url =
  process.env.TMS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

// The identity-mapping headers (canonical field name == source header today).
const REQUEST_HEADERS = Object.values(DEFAULT_REQUEST_COLUMN_MAPPING)
const DAMAGE_HEADERS = Object.values(DEFAULT_DAMAGE_COLUMN_MAPPING)

// A recipient-contact value that is PII: the preview must return it in the
// response object yet never log it.
const PII_CONTACT = 'Jane Doe'
const PII_MOBILE = '9000000000'

const BASE_REQUEST: Record<string, string> = {
  bankMerchantReference: 'BM-1',
  displayName: 'Acme',
  legalName: 'Acme Pvt Ltd',
  mcc: '5814',
  registeredAddress: '221B Baker Street',
  bankReferenceCode: '3',
  productType: 'soundbox',
  vpaValue: 'acme@hdfcbank',
  qrValue: 'upi://pay?pa=acme@hdfcbank',
  soundbox: 'true',
  standeeCount: '1',
  stickerCount: '2',
  shipToAddress: '221B Baker Street',
  contactName: PII_CONTACT,
  mobile: PII_MOBILE,
  branchCode: '30',
  vpaHint: 'acme@hdfcbank',
}

// Phase 3 Task 1 (BRD FR-08, FR-11): must be one of the four seeded
// damage_reason master examples (services/tms/prisma/migrations/
// 20260804163403_add_damage_reason_master), or the damage ingest now
// quarantines it (invalid_damage_reason) instead of replacing.
const BASE_DAMAGE: Record<string, string> = {
  tenantReference: 'HDFC',
  vpaValue: 'acme@hdfcbank',
  damageReason: 'battery issue',
  bankRemarks: 'replace asap',
  shipToAddress: 'New Addr',
}

function requestCells(over: Record<string, string> = {}): string[] {
  const rec = { ...BASE_REQUEST, ...over }
  return REQUEST_HEADERS.map((h) => rec[h] ?? '')
}

function damageCells(over: Record<string, string> = {}): string[] {
  const rec = { ...BASE_DAMAGE, ...over }
  return DAMAGE_HEADERS.map((h) => rec[h] ?? '')
}

function toCsv(header: string[], rows: string[][]): Uint8Array {
  const lines = [header, ...rows].map((r) => r.map((f) => (f.includes(',') ? `"${f}"` : f)).join(','))
  return new TextEncoder().encode(lines.join('\n') + '\n')
}

async function toXlsx(header: string[], rows: string[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('sheet1')
  ws.addRow(header)
  for (const r of rows) ws.addRow(r)
  const buf = await wb.xlsx.writeBuffer()
  return new Uint8Array(buf)
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE assignment, assignment_activation_event, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

// The row shape resolveQuarantineRow still accepts directly (that route is NOT
// the file-upload surface; it takes a single corrected row).
function validRow(over: Partial<BankRequestRow> = {}): BankRequestRow {
  return {
    fileId: 'file-1',
    rowNo: 1,
    bankMerchantReference: 'BM-1',
    displayName: 'Acme',
    legalName: 'Acme Pvt Ltd',
    mcc: '5814',
    registeredAddress: '221B Baker Street',
    bankReferenceCode: '3',
    productType: 'soundbox',
    vpaValue: 'acme@hdfcbank',
    qrValue: 'upi://pay?pa=acme@hdfcbank',
    soundbox: true,
    standeeCount: 1,
    stickerCount: 2,
    shipToAddress: '221B Baker Street',
    contactName: 'Jane Doe',
    mobile: '9000000000',
    branchCode: '30',
    vpaHint: 'acme@hdfcbank',
    ...over,
  }
}

async function seedOriginalAssignment(vpa: string, bank: string): Promise<string> {
  const asgnUuid = toUuid(newId('asgn'))
  await db.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, dispatch_group, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', ${bank}, 'HDFC Bank', 'Old Addr', 'upi://pay', ${vpa}, true, 1, 2,
    true, 'pooled-for-fulfillment', ${'ops-seed|' + vpa}, 'SOUNDBOX', now()
  )`
  return fromUuid('asgn', asgnUuid)
}

async function count(table: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${table}`)
  return Number(rows[0]!.n)
}

describe('tms ops preview (spec P2 Task 2): previewBankFile persists nothing and logs no PII', () => {
  it('returns per-row valid/invalid verdicts and a summary for a .csv, writing ZERO rows', async () => {
    const csv = toCsv(REQUEST_HEADERS, [requestCells(), requestCells({ contactName: '', bankMerchantReference: 'BM-2' })])

    const before = {
      pending: await count('pending_row'),
      quarantine: await count('quarantine_row'),
      ingest: await count('ingest_file'),
      outbox: await count('outbox'),
      inbox: await count('inbox'),
    }

    const res = await previewBankFile(db, csv, 'requests.csv')
    expect(res.structuralErrors).toEqual([])
    expect(res.summary).toEqual({ total: 2, valid: 1, invalid: 1 })
    expect(res.rows[0]!.valid).toBe(true)
    expect(res.rows[0]!.errors).toEqual([])
    expect(res.rows[1]!.valid).toBe(false)
    expect(res.rows[1]!.errors).toEqual(['missing_contact_name'])
    // The PII travels ONLY in the response row.
    expect(res.rows[0]!.row.contactName).toBe(PII_CONTACT)
    expect(res.rows[0]!.row.mobile).toBe(PII_MOBILE)

    // Persist-nothing: every ingest artifact is unchanged.
    expect(await count('pending_row')).toBe(before.pending)
    expect(await count('quarantine_row')).toBe(before.quarantine)
    expect(await count('ingest_file')).toBe(before.ingest)
    expect(await count('outbox')).toBe(before.outbox)
    expect(await count('inbox')).toBe(before.inbox)
  })

  it('parses .xlsx as well as .csv, and logs no row content (PII) on either', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ]
    try {
      const xlsx = await toXlsx(REQUEST_HEADERS, [requestCells()])
      const res = await previewBankFile(db, xlsx, 'requests.xlsx')
      expect(res.summary).toEqual({ total: 1, valid: 1, invalid: 0 })
      expect(res.rows[0]!.row.contactName).toBe(PII_CONTACT)

      // No console sink ever received the PII (or anything at all from the
      // preview path, which does no logging by construction).
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          const serialized = JSON.stringify(call)
          expect(serialized).not.toContain(PII_CONTACT)
          expect(serialized).not.toContain(PII_MOBILE)
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('surfaces a structural parse error (missing column) rather than throwing, with empty rows', async () => {
    const headerMissingMcc = REQUEST_HEADERS.filter((h) => h !== 'mcc')
    const rowMissingMcc = requestCells().filter((_v, idx) => REQUEST_HEADERS[idx] !== 'mcc')
    const csv = toCsv(headerMissingMcc, [rowMissingMcc])

    const res = await previewBankFile(db, csv, 'requests.csv')
    expect(res.rows).toEqual([])
    expect(res.summary).toEqual({ total: 0, valid: 0, invalid: 0 })
    expect(res.structuralErrors).toHaveLength(1)
    expect(res.structuralErrors[0]!.code).toBe('missing_required_column')
  })
})

describe('tms ops commit (spec P2 Task 2): commitBankFile / commitDamageFile parse server-side', () => {
  it('runs the S8 ingest under tms_write from a .csv: a valid row posts, a malformed row quarantines (partial-accept)', async () => {
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [requestCells(), requestCells({ contactName: '', bankMerchantReference: 'BM-2' })])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'requests.csv', clientKey, actorId: randomUUID(), traceId: 't1' })
    expect(r.accepted).toBe(1)
    expect(r.quarantined).toBe(1)
    expect(r.duplicate).toBe(0)
    // The fileId is the server-received clientKey, not a client body value.
    expect(r.fileId).toBe(clientKey)

    expect(await count('pending_row')).toBe(1)
    expect(await count('quarantine_row')).toBe(1)
  })

  // D-8. The D4 ruling ends "This is a compensating control for a bank-side bug,
  // not a fix. GSCB should still be told." This count is what there is to tell
  // them. Fulfillment CORRECTS the payload at the artifact boundary; TMS only
  // COUNTS, which is a format observation and not an alteration, so D117/T2 is
  // untouched: the stored value and the emitted fact stay verbatim.
  it('D-8: counts how many rows carried the bank malformed QR separator, without altering them', async () => {
    const clientKey = randomUUID()
    // Two malformed (the verbatim GSCB shape) and one already correct.
    const malformed = 'upi://pay?ver=01&amp;mode=01&pa=a@gscb&pn=A&mc=5977'
    const csv = toCsv(REQUEST_HEADERS, [
      requestCells({ qrValue: malformed }),
      requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'b@gscb', qrValue: malformed }),
      requestCells({ bankMerchantReference: 'BM-3', vpaValue: 'c@gscb', qrValue: 'upi://pay?ver=01&mode=01&pa=c@gscb' }),
    ])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'requests.csv', clientKey, actorId: randomUUID(), traceId: 't-qr' })

    expect(r.accepted).toBe(3)
    expect(r.qrMalformed).toBe(2)

    // D117/T2: TMS stores what the bank sent, byte for byte. The count is
    // evidence ABOUT the file, never a licence to rewrite it.
    const stored = await db.$queryRaw<{ qr_value: string }[]>`
      SELECT qr_value FROM pending_row WHERE correlation_id LIKE ${clientKey + '|%'} ORDER BY correlation_id
    `
    expect(stored.filter((s) => s.qr_value === malformed)).toHaveLength(2)
  })

  it('D-8: a clean file reports zero, so the number means something when it is not zero', async () => {
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [requestCells({ qrValue: 'upi://pay?ver=01&mode=01&pa=a@gscb' })])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'requests.csv', clientKey, actorId: randomUUID(), traceId: 't-qr0' })
    expect(r.qrMalformed).toBe(0)
  })

  // Deliberate: the count is evidence about what GSCB SENT, so it is independent
  // of whether we accepted the row. A row rejected for an unrelated reason still
  // arrived with a malformed payload, and dropping it from the tally would
  // understate the defect to the bank.
  it('D-8: counts a malformed QR on a row that quarantines for an unrelated reason', async () => {
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [
      requestCells({ qrValue: 'upi://pay?ver=01&amp;mode=01&pa=a@gscb', contactName: '' }),
    ])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'requests.csv', clientKey, actorId: randomUUID(), traceId: 't-qrq' })
    expect(r.quarantined).toBe(1)
    expect(r.accepted).toBe(0)
    expect(r.qrMalformed).toBe(1)
  })

  // Bhupender's ruling: "repeat VPA can be flagged in the ingestion part ...
  // the additional soundbox request may or may not be." So a repeat is FLAGGED
  // for review and never rejected, because the same VPA arriving again is the
  // legitimate additional-soundbox case at least as often as it is a mistake.
  // BRD 5.1b asks for exactly this ("detect duplicates ... and flag for review")
  // and pairs it with the additional-soundbox rule in one breath, which is the
  // clue that the two cannot be separated by an automatic rule.
  //
  // MIGRATED to soundbox: 'false' (ruling 2026-08-10). These three tests were
  // written against the BASE_REQUEST fixture, whose soundbox is 'true', and they
  // only ever asserted the counter, so they silently depended on a value they
  // never mentioned. A soundbox repeat is now HELD, so left as they were they
  // would have been asserting the new behaviour by accident while claiming to
  // assert the old one. Pinned to a sticker/standee row instead, which is
  // exactly the case the flag-never-gate reading still governs: this is now the
  // regression net for the half of D-2 that did NOT change.
  it('D-2: flags a VPA repeated INSIDE one file, without blocking either row (sticker/standee rows)', async () => {
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [
      requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'same@gscb', soundbox: 'false' }),
      requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'same@gscb', soundbox: 'false' }),
      requestCells({ bankMerchantReference: 'BM-3', vpaValue: 'other@gscb', soundbox: 'false' }),
    ])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't-dup1' })

    // The flag is a NOTICE, not a gate: all three rows still ingest, so an
    // additional-soundbox order is never stalled waiting for someone to look.
    expect(r.accepted).toBe(3)
    expect(r.quarantined).toBe(0)
    // The FIRST sighting is not a repeat; only the second is.
    expect(r.duplicateVpa).toBe(1)
    // And nothing was held: the gate is soundbox-only.
    expect(r.duplicateVpaHeld).toEqual([])
    expect(await count('pending_row')).toBe(3)
  })

  // "in same upload or RECENT UPLOADS" (BRD 5.1b). A merchant who was ordered
  // for last week and appears again today is the case that actually matters,
  // and it is invisible to a within-file check.
  it('D-2: flags a VPA already present from an EARLIER upload (sticker/standee rows)', async () => {
    const first = randomUUID()
    await commitBankFile(db, {
      fileBytes: toCsv(REQUEST_HEADERS, [requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'seen@gscb', soundbox: 'false' })]),
      filename: 'a.csv', clientKey: first, actorId: randomUUID(), traceId: 't-dup2a',
    })

    const second = randomUUID()
    const r = await commitBankFile(db, {
      fileBytes: toCsv(REQUEST_HEADERS, [
        requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'seen@gscb', soundbox: 'false' }),
        requestCells({ bankMerchantReference: 'BM-3', vpaValue: 'fresh@gscb', soundbox: 'false' }),
      ]),
      filename: 'b.csv', clientKey: second, actorId: randomUUID(), traceId: 't-dup2b',
    })

    expect(r.accepted).toBe(2)
    expect(r.duplicateVpa).toBe(1)
    expect(r.duplicateVpaHeld).toEqual([])
  })

  it('D-2: a file of distinct VPAs flags nothing, so a non-zero count means something', async () => {
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [
      requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'a1@gscb', soundbox: 'false' }),
      requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'a2@gscb', soundbox: 'false' }),
    ])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't-dup3' })
    expect(r.duplicateVpa).toBe(0)
  })

  // BRD 5.1b asks for "same VPA / Mobile". Mobile is a DIFFERENT signal from
  // VPA and is counted differently on purpose.
  //
  // A repeat VPA is the same merchant coming back, which is the
  // additional-soundbox case. A repeat MOBILE on a DIFFERENT VPA is two
  // distinct merchants sharing a contact number: one owner with two shops, a
  // shared shopkeeper phone, or a typo. That is the case worth a human look,
  // and it is invisible to the VPA check.
  //
  // MEASURED in the real 360-row GSCB file: 3 mobiles repeat, and all 3 are
  // across DIFFERENT VPAs. So this is the flag that actually fires on real
  // data, where the VPA flag never does.
  it('D-2: flags one mobile shared by two DIFFERENT merchants', async () => {
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [
      requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'm1@gscb', mobile: '9811111111' }),
      requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'm2@gscb', mobile: '9811111111' }),
      requestCells({ bankMerchantReference: 'BM-3', vpaValue: 'm3@gscb', mobile: '9822222222' }),
    ])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't-mob1' })

    expect(r.accepted).toBe(3)
    expect(r.duplicateMobile).toBe(1)
    // Different merchants, so this is NOT a VPA repeat.
    expect(r.duplicateVpa).toBe(0)
  })

  // The one that keeps the notice honest. The SAME merchant reappearing
  // repeats its mobile too, by definition. Counting that as a mobile duplicate
  // would double-report one benign situation and train an operator to ignore
  // both flags.
  it('D-2: does NOT flag the mobile when it is the same merchant returning', async () => {
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [
      requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'same@gscb', mobile: '9833333333' }),
      requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'same@gscb', mobile: '9833333333' }),
    ])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't-mob2' })

    expect(r.duplicateVpa).toBe(1)
    expect(r.duplicateMobile).toBe(0)
  })

  it('D-2: flags a mobile already used by a different merchant in an EARLIER upload', async () => {
    const first = randomUUID()
    await commitBankFile(db, {
      fileBytes: toCsv(REQUEST_HEADERS, [requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'e1@gscb', mobile: '9844444444' })]),
      filename: 'a.csv', clientKey: first, actorId: randomUUID(), traceId: 't-mob3a',
    })

    const second = randomUUID()
    const r = await commitBankFile(db, {
      fileBytes: toCsv(REQUEST_HEADERS, [requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'e2@gscb', mobile: '9844444444' })]),
      filename: 'b.csv', clientKey: second, actorId: randomUUID(), traceId: 't-mob3b',
    })

    expect(r.accepted).toBe(1)
    expect(r.duplicateMobile).toBe(1)
  })

  it('D-2: distinct mobiles flag nothing', async () => {
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [
      requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'd1@gscb', mobile: '9855555555' }),
      requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'd2@gscb', mobile: '9866666666' }),
    ])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't-mob4' })
    expect(r.duplicateMobile).toBe(0)
  })

  it('parses a .xlsx commit to the same outcome as the equivalent .csv', async () => {
    const clientKey = randomUUID()
    const xlsx = await toXlsx(REQUEST_HEADERS, [requestCells()])
    const r = await commitBankFile(db, { fileBytes: xlsx, filename: 'requests.xlsx', clientKey, actorId: randomUUID(), traceId: 't-xlsx' })
    expect(r.accepted).toBe(1)
    expect(r.quarantined).toBe(0)
    expect(await count('pending_row')).toBe(1)
  })

  it('is idempotent on the client key: a replay is a no-op (deduped by the E6 inbox)', async () => {
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [requestCells()])
    const first = await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't2' })
    const replay = await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't2' })
    expect(first.accepted).toBe(1)
    expect(replay.accepted).toBe(0)
    expect(replay.quarantined).toBe(0)
    expect(replay.duplicate).toBe(0)
    // The returned fileId is stable across the replay (names the ingested file).
    expect(replay.fileId).toBe(clientKey)
    expect(await count('pending_row')).toBe(1)
  })

  it('throws BankFileParseError (kind: invalid) on a structural parse failure and writes nothing', async () => {
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [requestCells()])
    await expect(
      commitBankFile(db, { fileBytes: csv, filename: 'requests.txt', clientKey, actorId: randomUUID(), traceId: 't-bad' }),
    ).rejects.toMatchObject({ kind: 'invalid' })
    // Nothing persisted: the throw happens before any transaction opens.
    expect(await count('pending_row')).toBe(0)
    expect(await count('quarantine_row')).toBe(0)
    expect(await count('outbox')).toBe(0)
    // And it is the exported domain error type carrying the structural detail.
    try {
      await commitBankFile(db, { fileBytes: csv, filename: 'requests.txt', clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-bad2' })
      expect.unreachable('commit on an unsupported extension must throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BankFileParseError)
      expect((err as BankFileParseError).structuralErrors[0]!.code).toBe('unsupported_extension')
    }
  })

  it('commitDamageFile runs the damage ingest under tms_write: a matched row replaces, an unmatched row quarantines', async () => {
    // Task 4 (W-5): seedOriginalAssignment is the LEGACY combined shape (one
    // row, soundbox=true AND standee_count/sticker_count > 0), so the matched
    // row's like-for-like clone mints TWO replacement groups (SOUNDBOX +
    // COLLATERAL) for the one matched ROW, not one; `r.replaced` still counts
    // 1 because it is a per-ROW outcome.
    await seedOriginalAssignment('acme@hdfcbank', 'HDFC')
    const clientKey = randomUUID()
    const csv = toCsv(DAMAGE_HEADERS, [
      damageCells(),
      damageCells({ vpaValue: 'unknown@hdfcbank', damageReason: 'x', bankRemarks: '', shipToAddress: 'A' }),
    ])
    const r = await commitDamageFile(db, { fileBytes: csv, filename: 'damage.csv', clientKey, actorId: randomUUID(), traceId: 't3' })
    expect(r.replaced).toBe(1)
    expect(r.quarantined).toBe(1)
    expect(r.duplicate).toBe(0)
    expect(r.fileId).toBe(clientKey)

    const repl = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment WHERE replacement_of IS NOT NULL`
    expect(Number(repl[0]!.n)).toBe(2)
  })

  it('commitDamageFile is idempotent on the client key (replay is a no-op)', async () => {
    await seedOriginalAssignment('acme@hdfcbank', 'HDFC')
    const clientKey = randomUUID()
    const csv = toCsv(DAMAGE_HEADERS, [damageCells({ bankRemarks: '' })])
    const first = await commitDamageFile(db, { fileBytes: csv, filename: 'damage.csv', clientKey, actorId: randomUUID(), traceId: 't4' })
    const replay = await commitDamageFile(db, { fileBytes: csv, filename: 'damage.csv', clientKey, actorId: randomUUID(), traceId: 't4' })
    expect(first.replaced).toBe(1)
    expect(replay.replaced).toBe(0)
    expect(replay.quarantined).toBe(0)
    expect(replay.duplicate).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The soundbox duplicate-VPA gate (ruling 2026-08-10). SUPERSEDES D-2's
// "a flag, never a gate" reading FOR SOUNDBOX ROWS ONLY: a soundbox row whose
// VPA we already serve is HELD (quarantined as duplicate_vpa_soundbox) and the
// quarantine record NAMES the original. Sticker/standee rows are unaffected and
// keep the counters, which the three migrated D-2 tests above now guard.
// ---------------------------------------------------------------------------
describe('soundbox duplicate-VPA hold (ruling 2026-08-10): commitBankFile', () => {
  async function quarantineDetail(fileId: string, rowNo: number) {
    const rows = await db.$queryRaw<{ reason_code: string; detail: { duplicateOf?: { kind: string; reference: string; merchantDisplayName: string | null } } | null }[]>`
      SELECT reason_code, detail FROM quarantine_row WHERE file_id = ${fileId} AND row_no = ${rowNo}
    `
    return rows[0]
  }

  // The plain within-file case, and the one that shows the two halves of the
  // ruling do not fight: the FIRST row still ingests (it is not a duplicate of
  // anything), the second is held, and the D-2 counter still reports 1 repeat
  // because the counter describes the FILE, not the outcome.
  it('holds the SECOND soundbox row of a repeated VPA and names the earlier row of the same file', async () => {
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [
      requestCells({ bankMerchantReference: 'BM-1', displayName: 'Chai Point', vpaValue: 'twice@gscb' }),
      requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'twice@gscb' }),
    ])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't-sb1' })

    expect(r.accepted).toBe(1)
    expect(r.quarantined).toBe(1)
    // Unchanged evidence about the file: one repeat, held or not.
    expect(r.duplicateVpa).toBe(1)
    expect(r.duplicateVpaHeld).toEqual([
      { rowNo: 2, duplicateOf: { kind: 'file_row', reference: '1', merchantDisplayName: 'Chai Point' } },
    ])

    const q = await quarantineDetail(clientKey, 2)
    expect(q!.reason_code).toBe('duplicate_vpa_soundbox')
    expect(q!.detail!.duplicateOf).toEqual({ kind: 'file_row', reference: '1', merchantDisplayName: 'Chai Point' })
    // Exactly one row reached pending_row: the first.
    expect(await count('pending_row')).toBe(1)
  })

  // The case the ruling actually exists for: the merchant already HAS a device.
  // The original is an assignment, so the reference is the WIRE asgn id (D-A)
  // and the operator gets the merchant name beside it.
  it('holds a soundbox row against a prior ASSIGNMENT, naming its wire asgn id and merchant', async () => {
    const asgnId = await seedOriginalAssignment('prior@gscb', '3')
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [requestCells({ bankMerchantReference: 'BM-9', vpaValue: 'prior@gscb' })])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't-sb2' })

    expect(r.accepted).toBe(0)
    expect(r.quarantined).toBe(1)
    expect(r.duplicateVpaHeld).toEqual([
      { rowNo: 1, duplicateOf: { kind: 'assignment', reference: asgnId, merchantDisplayName: 'Acme' } },
    ])
    expect(asgnId.startsWith('asgn_')).toBe(true)

    const q = await quarantineDetail(clientKey, 1)
    expect(q!.reason_code).toBe('duplicate_vpa_soundbox')
    expect(q!.detail!.duplicateOf!.kind).toBe('assignment')
    expect(q!.detail!.duplicateOf!.reference).toBe(asgnId)
  })

  // "in same upload or recent uploads" (BRD 5.1b): the original is still
  // awaiting identity, so it is a pending_row and the reference is its
  // correlation_id, which names the upload AND the line inside it. pending_row
  // has no display-name column, so the name is honestly null rather than
  // invented.
  it('holds a soundbox row against a prior PENDING_ROW, naming its correlation id', async () => {
    const first = randomUUID()
    await commitBankFile(db, {
      fileBytes: toCsv(REQUEST_HEADERS, [requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'earlier@gscb' })]),
      filename: 'a.csv', clientKey: first, actorId: randomUUID(), traceId: 't-sb3a',
    })

    const second = randomUUID()
    const r = await commitBankFile(db, {
      fileBytes: toCsv(REQUEST_HEADERS, [requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'earlier@gscb' })]),
      filename: 'b.csv', clientKey: second, actorId: randomUUID(), traceId: 't-sb3b',
    })

    expect(r.quarantined).toBe(1)
    expect(r.duplicateVpaHeld).toEqual([
      { rowNo: 1, duplicateOf: { kind: 'pending_row', reference: `${first}|1`, merchantDisplayName: null } },
    ])
  })

  // The half of D-2 that did NOT change, asserted end to end rather than only
  // via the migrated counter tests: a collateral-only repeat still ingests.
  it('does NOT hold a soundbox=false repeat: it is accepted and only counted', async () => {
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [
      requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'sticker@gscb', soundbox: 'false' }),
      requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'sticker@gscb', soundbox: 'false' }),
    ])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't-sb4' })

    expect(r.accepted).toBe(2)
    expect(r.quarantined).toBe(0)
    expect(r.duplicateVpa).toBe(1)
    expect(r.duplicateVpaHeld).toEqual([])
    expect(await count('quarantine_row')).toBe(0)
  })

  // A sticker row still SEEDS, even though it can never be held itself. A gate
  // that only remembered soundbox rows would let a soundbox row slip through
  // behind a collateral row for the same merchant.
  it('a soundbox=false row still seeds: a later soundbox row for the same VPA is held', async () => {
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [
      requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'mixed@gscb', soundbox: 'false' }),
      requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'mixed@gscb', soundbox: 'true' }),
    ])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't-sb5' })

    expect(r.accepted).toBe(1)
    expect(r.quarantined).toBe(1)
    expect(r.duplicateVpaHeld.map((h) => h.rowNo)).toEqual([2])
  })

  // Merchant identity is `v1:vpa:<lower(vpa)>` (D1 interim), so a casing
  // difference is the SAME merchant. A case-sensitive gate would be defeated by
  // one capital letter in the bank's export.
  it('matches case-insensitively: an upper-case VPA is the same merchant', async () => {
    const asgnId = await seedOriginalAssignment('Mixed.Case@GSCB', '3')
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'mixed.case@gscb' })])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't-sb6' })

    expect(r.quarantined).toBe(1)
    expect(r.duplicateVpaHeld[0]!.duplicateOf.reference).toBe(asgnId)
  })

  // FIRST-ERROR-WINS is preserved. The operator is told the thing they can
  // actually fix; the duplicate is still there afterwards and is caught on the
  // re-submission (see the resolveQuarantineRow test below).
  it('reports the FORMAT reason, not the duplicate, when a held row also fails a format rule', async () => {
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [
      requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'both@gscb' }),
      requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'both@gscb', contactName: '' }),
    ])
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't-sb7' })

    expect(r.accepted).toBe(1)
    expect(r.quarantined).toBe(1)
    // The counter is evidence about the file, so the repeat is still counted.
    expect(r.duplicateVpa).toBe(1)
    // But the row was NOT held FOR the duplicate, so it must not be listed as
    // such: it would send the operator looking for the wrong problem.
    expect(r.duplicateVpaHeld).toEqual([])

    const q = await quarantineDetail(clientKey, 2)
    expect(q!.reason_code).toBe('missing_contact_name')
    expect(q!.detail).toBeNull()
  })

  // W-5 left an operator-facing wart: one bank row mints TWO assignments, a
  // SOUNDBOX leg and a COLLATERAL leg, both carrying the same VPA and both
  // inserted in one transaction, so `created_at` ties exactly. Whichever the
  // plan emitted first won the tie, which could be the COLLATERAL leg: the
  // operator was then told their soundbox row duplicates the STANDEE
  // consignment. True, and useless.
  it('names the SOUNDBOX sibling as the original, not the collateral one', async () => {
    const sourceEventId = `ops-seed|siblings@gscb`
    const ids: Record<string, string> = {}
    // Deliberately inserted COLLATERAL FIRST, so a test that passes cannot be
    // passing by insertion luck.
    for (const group of ['COLLATERAL', 'SOUNDBOX']) {
      const asgnUuid = toUuid(newId('asgn'))
      ids[group] = fromUuid('asgn', asgnUuid)
      await db.$executeRaw`INSERT INTO assignment (
        id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
        bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
        billable, demand_state, source_event_id, dispatch_group, updated_at
      ) VALUES (
        ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
        'Acme', 'Acme Pvt Ltd', '5814', '3', 'HDFC Bank', 'Old Addr', 'upi://pay', 'siblings@gscb',
        ${group === 'SOUNDBOX'}, 1, 2,
        true, 'pooled-for-fulfillment', ${sourceEventId}, ${group}, now()
      )`
    }

    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'siblings@gscb' })])
    await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't-sib' })

    const q = await quarantineDetail(clientKey, 1)
    expect(q!.reason_code).toBe('duplicate_vpa_soundbox')
    expect(q!.detail!.duplicateOf!.reference).toBe(ids.SOUNDBOX)
    expect(q!.detail!.duplicateOf!.reference).not.toBe(ids.COLLATERAL)
  })

  it('readQuarantineQueue exposes the detail, so the ops queue can name the original', async () => {
    const asgnId = await seedOriginalAssignment('queue@gscb', '3')
    const clientKey = randomUUID()
    const csv = toCsv(REQUEST_HEADERS, [requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'queue@gscb' })])
    await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey, actorId: randomUUID(), traceId: 't-sb8' })

    const open = await readQuarantineQueue(db, { includeResolved: false })
    const held = open.find((q) => q.reasonCode === 'duplicate_vpa_soundbox')
    expect(held).toBeDefined()
    expect(held!.detail!.duplicateOf).toEqual({ kind: 'assignment', reference: asgnId, merchantDisplayName: 'Acme' })

    // Every other reason carries no detail at all, so a null there is normal and
    // not a missing write.
    await db.$executeRaw`
      INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
      VALUES ('plain-file', 1, ${'redacted:bank_request'}, 'missing_contact_name')
    `
    const all = await readQuarantineQueue(db, { includeResolved: true })
    expect(all.find((q) => q.fileId === 'plain-file')!.detail).toBeNull()
  })

  // The per-row fallback (`duplicateVpaOriginal` left undefined) earns its keep
  // here: resolveQuarantineRow knows nothing about the gate, yet a corrected row
  // that is STILL a duplicate re-quarantines with a named original.
  it('resolveQuarantineRow re-quarantines a corrected row that is still a duplicate', async () => {
    const asgnId = await seedOriginalAssignment('resolve@gscb', '3')
    const seeded = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
      VALUES ('res-file', 1, ${'redacted:bank_request'}, 'missing_contact_name')
      RETURNING id
    `
    const res = await resolveQuarantineRow(db, {
      quarantineId: seeded[0]!.id,
      // The contact name is fixed, but the VPA still belongs to a merchant who
      // already has a device.
      correctedRow: validRow({ fileId: 'res-corrected', rowNo: 1, vpaValue: 'resolve@gscb', qrValue: 'upi://pay?pa=resolve@gscb' }),
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-sb9',
    })
    expect(res.outcome).toBe('quarantined')

    const q = await db.$queryRaw<{ reason_code: string; detail: { duplicateOf?: { reference: string } } | null }[]>`
      SELECT reason_code, detail FROM quarantine_row WHERE file_id = 'res-corrected' AND row_no = 1
    `
    expect(q[0]!.reason_code).toBe('duplicate_vpa_soundbox')
    expect(q[0]!.detail!.duplicateOf!.reference).toBe(asgnId)
    // No pending_row was created for it: a held row does not ingest.
    expect(await count('pending_row')).toBe(0)
  })

  // D-8's SECOND action, which did not exist: "Close: it was a genuine
  // duplicate. Record is closed and removed from the queue (retained in
  // archive)." Before this, the only action re-drove an ingest, so an operator
  // holding a genuine duplicate had to either invent a correction or leave the
  // row in the queue forever, and D-8's target state is an EMPTY queue.
  describe('closeQuarantineRow (D-8 Close)', () => {
    async function seedHeld(fileId: string): Promise<string> {
      const seeded = await db.$queryRaw<{ id: string }[]>`
        INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
        VALUES (${fileId}, 1, ${'redacted:bank_request'}, 'duplicate_vpa_soundbox')
        RETURNING id
      `
      return seeded[0]!.id
    }

    it('archives the row as closed, ingests NOTHING, and co-commits one ALLOW 6e', async () => {
      const id = await seedHeld('close-file-1')
      const actorId = randomUUID()
      const res = await closeQuarantineRow(db, { quarantineId: id, clientKey: randomUUID(), actorId, traceId: 't-close-1' })

      expect(res).toEqual({ deduped: false, closed: true })

      const row = await db.$queryRaw<{ resolved_at: Date | null; resolved_by_actor: string | null; resolution: string | null }[]>`
        SELECT resolved_at, resolved_by_actor, resolution FROM quarantine_row WHERE id = ${id}::uuid
      `
      expect(row[0]!.resolved_at).not.toBeNull()
      expect(row[0]!.resolved_by_actor).toBe(actorId)
      // The discriminator is the point: a closed row must not read as a cure
      // that happened to do nothing.
      expect(row[0]!.resolution).toBe('closed')

      // NOTHING was ingested. This is what separates Close from Cure.
      expect(await count('pending_row')).toBe(0)

      const audit = await db.$queryRaw<{ payload: { operation: string; decision: string; resourceIds: string[] } }[]>`
        SELECT payload FROM outbox WHERE event_type = 'authz.audit'
      `
      expect(audit).toHaveLength(1)
      expect(audit[0]!.payload).toMatchObject({
        operation: 'ops:close-quarantine',
        decision: 'ALLOW',
        resourceIds: [id],
      })
    })

    it('leaves the queue: a closed row is gone from the open list but still in the archive', async () => {
      const id = await seedHeld('close-file-2')
      await closeQuarantineRow(db, { quarantineId: id, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-close-2' })

      const open = await readQuarantineQueue(db, { includeResolved: false })
      expect(open.find((q) => q.id === id)).toBeUndefined()

      const archived = await readQuarantineQueue(db, { includeResolved: true })
      const found = archived.find((q) => q.id === id)
      expect(found).toBeDefined()
      expect(found!.resolution).toBe('closed')
    })

    it('a client-key replay is a no-op, not a second stamp or a second 6e', async () => {
      const id = await seedHeld('close-file-3')
      const clientKey = randomUUID()
      const first = await closeQuarantineRow(db, { quarantineId: id, clientKey, actorId: randomUUID(), traceId: 't-close-3a' })
      expect(first.closed).toBe(true)

      const replay = await closeQuarantineRow(db, { quarantineId: id, clientKey, actorId: randomUUID(), traceId: 't-close-3b' })
      expect(replay.deduped).toBe(true)

      const audit = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM outbox WHERE event_type = 'authz.audit'
      `
      expect(Number(audit[0]!.n)).toBe(1)
    })

    it('does NOT overwrite a row someone already cured, and says so', async () => {
      // The race that matters: two operators looking at the same queue. The
      // UPDATE's `resolved_at IS NULL` predicate is what protects the earlier
      // resolution, and `closed: false` is how the caller learns it lost.
      const id = await seedHeld('close-file-4')
      await resolveQuarantineRow(db, {
        quarantineId: id,
        correctedRow: validRow({ fileId: 'close-cured', rowNo: 1, vpaValue: 'fresh@gscb', qrValue: 'upi://pay?pa=fresh@gscb' }),
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't-close-4a',
      })

      const res = await closeQuarantineRow(db, { quarantineId: id, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-close-4b' })
      expect(res).toEqual({ deduped: false, closed: false })

      const row = await db.$queryRaw<{ resolution: string | null }[]>`
        SELECT resolution FROM quarantine_row WHERE id = ${id}::uuid
      `
      expect(row[0]!.resolution).toBe('cured') // the cure stands
    })

    it('curing stamps the OTHER resolution, so the two are told apart in the archive', async () => {
      const id = await seedHeld('close-file-5')
      await resolveQuarantineRow(db, {
        quarantineId: id,
        correctedRow: validRow({ fileId: 'cured-file-5', rowNo: 1, vpaValue: 'cured5@gscb', qrValue: 'upi://pay?pa=cured5@gscb' }),
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't-close-5',
      })
      const row = await db.$queryRaw<{ resolution: string | null }[]>`
        SELECT resolution FROM quarantine_row WHERE id = ${id}::uuid
      `
      expect(row[0]!.resolution).toBe('cured')
    })
  })
})

// PREVIEW PARITY is the whole point of keeping duplicateVpaVerdicts pure: a
// preview that showed a row as valid and then quarantined it on commit is
// exactly the surprise a preview exists to prevent.
describe('soundbox duplicate-VPA hold (ruling 2026-08-10): previewBankFile parity', () => {
  it('previews a row against a seeded assignment as INVALID, naming the original', async () => {
    const asgnId = await seedOriginalAssignment('pv1@gscb', '3')
    const csv = toCsv(REQUEST_HEADERS, [requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'pv1@gscb' })])
    const res = await previewBankFile(db, csv, 'r.csv')

    expect(res.summary).toEqual({ total: 1, valid: 0, invalid: 1 })
    expect(res.rows[0]!.errors).toEqual(['duplicate_vpa_soundbox'])
    expect(res.rows[0]!.duplicateOf).toEqual({ kind: 'assignment', reference: asgnId, merchantDisplayName: 'Acme' })
    // A SIBLING of `row`, never inside it: the portal derives its preview
    // columns reflectively from Object.keys(row).
    expect(Object.keys(res.rows[0]!.row)).not.toContain('duplicateOf')
  })

  it('previews a within-file pair as first valid, second invalid, exactly as the commit resolves it', async () => {
    const csv = toCsv(REQUEST_HEADERS, [
      requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'pv2@gscb' }),
      requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'pv2@gscb' }),
    ])
    const res = await previewBankFile(db, csv, 'r.csv')
    expect(res.rows[0]!.valid).toBe(true)
    expect(res.rows[1]!.valid).toBe(false)
    expect(res.rows[1]!.duplicateOf!.kind).toBe('file_row')
    expect(res.rows[1]!.duplicateOf!.reference).toBe('1')

    // And the commit reaches the SAME verdict on the same bytes.
    const r = await commitBankFile(db, { fileBytes: csv, filename: 'r.csv', clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-pv2' })
    expect(r.accepted).toBe(1)
    expect(r.quarantined).toBe(1)
    expect(r.duplicateVpaHeld.map((h) => h.rowNo)).toEqual([2])
  })

  it('previews a soundbox=false repeat as VALID: the gate is soundbox-only on both surfaces', async () => {
    const csv = toCsv(REQUEST_HEADERS, [
      requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'pv3@gscb', soundbox: 'false' }),
      requestCells({ bankMerchantReference: 'BM-2', vpaValue: 'pv3@gscb', soundbox: 'false' }),
    ])
    const res = await previewBankFile(db, csv, 'r.csv')
    expect(res.summary).toEqual({ total: 2, valid: 2, invalid: 0 })
    expect(res.rows.every((row) => row.duplicateOf === undefined)).toBe(true)
  })

  // The preview now READS, so persist-nothing has to be re-proven rather than
  // assumed: a read is not persistence, and nothing about the write plane moved.
  it('still persists NOTHING even though it now reads the seed', async () => {
    await seedOriginalAssignment('pv4@gscb', '3')
    const before = {
      pending: await count('pending_row'),
      quarantine: await count('quarantine_row'),
      ingest: await count('ingest_file'),
      outbox: await count('outbox'),
      inbox: await count('inbox'),
    }
    const csv = toCsv(REQUEST_HEADERS, [requestCells({ bankMerchantReference: 'BM-1', vpaValue: 'pv4@gscb' })])
    const res = await previewBankFile(db, csv, 'r.csv')
    expect(res.rows[0]!.valid).toBe(false)

    expect(await count('pending_row')).toBe(before.pending)
    expect(await count('quarantine_row')).toBe(before.quarantine)
    expect(await count('ingest_file')).toBe(before.ingest)
    expect(await count('outbox')).toBe(before.outbox)
    expect(await count('inbox')).toBe(before.inbox)
  })
})

describe('FR08-2: damage case-status transition + ops-read working list', () => {
  // Seed an original, then commit a damage row so a replacement (case_status
  // Open) exists; return one WIRE asgn id (what the edge passes). Task 4
  // (W-5): seedOriginalAssignment is the legacy combined shape, so this
  // actually mints TWO replacement groups (SOUNDBOX + COLLATERAL); either one
  // is a valid case_status target for the tests in this describe block, which
  // only exercise a single case by its wire id.
  async function seedOneReplacement(vpa = 'acme@hdfcbank'): Promise<string> {
    await seedOriginalAssignment(vpa, 'HDFC')
    const csv = toCsv(DAMAGE_HEADERS, [damageCells({ vpaValue: vpa })])
    await commitDamageFile(db, { fileBytes: csv, filename: 'damage.csv', clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-seed' })
    const repl = await db.$queryRaw<{ id: string }[]>`SELECT id FROM assignment WHERE replacement_of IS NOT NULL AND vpa_value = ${vpa} ORDER BY dispatch_group LIMIT 1`
    return fromUuid('asgn', repl[0]!.id)
  }

  it('transitions case_status Open -> Closed and co-commits an ALLOW 6e (wire id only)', async () => {
    const asgnId = await seedOneReplacement()
    const actorId = randomUUID()
    const r = await updateDamageCaseStatusOps(db, { asgnId, newStatus: 'Closed', clientKey: randomUUID(), actorId, traceId: 't-tr' })
    expect(r.deduped).toBe(false)
    const row = await db.$queryRaw<{ case_status: string }[]>`SELECT case_status FROM assignment WHERE id = ${toUuid(asgnId)}::uuid`
    expect(row[0]!.case_status).toBe('Closed')
    // the co-committed 6e (authz.audit) is ALLOW and carries the WIRE asgn id
    // (never a raw uuid, never PII), with actor = the principal.
    const audit = await db.$queryRaw<{ payload: { decision: string; operation: string; resourceIds?: string[]; principalId: string } }[]>`
      SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
    const found = audit.map((a) => a.payload).find((p) => p.operation === 'ops:update-damage-case')
    expect(found).toBeTruthy()
    expect(found!.decision).toBe('ALLOW')
    expect(found!.resourceIds).toEqual([asgnId])
    expect(found!.principalId).toBe(actorId)
  })

  it('rejects an invalid status with a client error, writing nothing', async () => {
    const asgnId = await seedOneReplacement()
    await expect(
      updateDamageCaseStatusOps(db, { asgnId, newStatus: 'Bogus', clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-bad' }),
    ).rejects.toBeInstanceOf(OpsClientError)
    const row = await db.$queryRaw<{ case_status: string }[]>`SELECT case_status FROM assignment WHERE id = ${toUuid(asgnId)}::uuid`
    expect(row[0]!.case_status).toBe('Open')
  })

  it('rejects a target that is not a replacement (client error)', async () => {
    // the ORIGINAL assignment is not a replacement (replacement_of IS NULL)
    await seedOriginalAssignment('solo@hdfcbank', 'HDFC')
    const orig = await db.$queryRaw<{ id: string }[]>`SELECT id FROM assignment WHERE vpa_value = 'solo@hdfcbank' AND replacement_of IS NULL`
    const origWire = fromUuid('asgn', orig[0]!.id)
    await expect(
      updateDamageCaseStatusOps(db, { asgnId: origWire, newStatus: 'Closed', clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-no' }),
    ).rejects.toBeInstanceOf(OpsClientError)
  })

  it('is idempotent on the client key (replay is a no-op)', async () => {
    const asgnId = await seedOneReplacement()
    const clientKey = randomUUID()
    const first = await updateDamageCaseStatusOps(db, { asgnId, newStatus: 'In-Progress', clientKey, actorId: randomUUID(), traceId: 't-i' })
    const replay = await updateDamageCaseStatusOps(db, { asgnId, newStatus: 'In-Progress', clientKey, actorId: randomUUID(), traceId: 't-i' })
    expect(first.deduped).toBe(false)
    expect(replay.deduped).toBe(true)
  })

  it('readDamageCases emits wire ids and excludes Closed by default, includeClosed shows all', async () => {
    const openAsgn = await seedOneReplacement('open@hdfcbank')
    const closedAsgn = await seedOneReplacement('closed@hdfcbank')
    await updateDamageCaseStatusOps(db, { asgnId: closedAsgn, newStatus: 'Closed', clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-c' })

    const openOnly = await readDamageCases(db, { includeClosed: false })
    const openIds = openOnly.map((c) => c.asgnId)
    expect(openIds).toContain(openAsgn)
    expect(openIds).not.toContain(closedAsgn)
    // wire-id shape (asgn_ prefix), and the original is exposed as a wire id too
    expect(openOnly.every((c) => c.asgnId.startsWith('asgn_') && c.replacementOf.startsWith('asgn_'))).toBe(true)

    const all = await readDamageCases(db, { includeClosed: true })
    expect(all.map((c) => c.asgnId)).toContain(closedAsgn)
  })
})

describe('tms ops API (spec 10c Task 5): quarantine resolution, ops-read', () => {
  it('resolveQuarantineRow re-drives ingest and stamps resolved_at/resolved_by_actor without mutating other quarantine state', async () => {
    const seeded = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
      VALUES ('seed-file', 1, ${'redacted:bank_request'}, 'missing_contact_name')
      RETURNING id
    `
    const otherSeeded = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
      VALUES ('seed-file', 2, ${'redacted:bank_request'}, 'invalid_qr_vpa_format')
      RETURNING id
    `
    const quarantineId = seeded[0]!.id
    const otherId = otherSeeded[0]!.id
    const actorId = randomUUID()

    const res = await resolveQuarantineRow(db, {
      quarantineId,
      correctedRow: validRow({ fileId: 'corrected-file', rowNo: 1 }),
      clientKey: randomUUID(),
      actorId,
      traceId: 't5',
    })
    expect(res.deduped).toBe(false)
    expect(res.outcome).toBe('accepted')

    const pend = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pending_row WHERE correlation_id = 'corrected-file|1'`
    expect(Number(pend[0]!.n)).toBe(1)

    const stamped = await db.$queryRaw<{ resolved_at: Date | null; resolved_by_actor: string | null }[]>`
      SELECT resolved_at, resolved_by_actor FROM quarantine_row WHERE id = ${quarantineId}::uuid
    `
    expect(stamped[0]!.resolved_at).not.toBeNull()
    expect(stamped[0]!.resolved_by_actor).toBe(actorId)

    // the OTHER quarantine row is untouched (A2: append-only, never mutated).
    const untouched = await db.$queryRaw<{ resolved_at: Date | null; reason_code: string }[]>`
      SELECT resolved_at, reason_code FROM quarantine_row WHERE id = ${otherId}::uuid
    `
    expect(untouched[0]!.resolved_at).toBeNull()
    expect(untouched[0]!.reason_code).toBe('invalid_qr_vpa_format')
  })

  it('resolveQuarantineRow replay (same clientKey) is unambiguous: deduped true, outcome null, no re-stamp', async () => {
    const seeded = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
      VALUES ('seed-file-2', 1, ${'redacted:bank_request'}, 'missing_contact_name')
      RETURNING id
    `
    const quarantineId = seeded[0]!.id
    const actorId = randomUUID()
    const clientKey = randomUUID()
    const correctedRow = validRow({ fileId: 'corrected-file-2', rowNo: 1 })

    const first = await resolveQuarantineRow(db, {
      quarantineId,
      correctedRow,
      clientKey,
      actorId,
      traceId: 't6',
    })
    expect(first.deduped).toBe(false)
    expect(first.outcome).toBe('accepted')

    const stampedAfterFirst = await db.$queryRaw<{ resolved_at: Date | null; resolved_by_actor: string | null }[]>`
      SELECT resolved_at, resolved_by_actor FROM quarantine_row WHERE id = ${quarantineId}::uuid
    `
    expect(stampedAfterFirst[0]!.resolved_at).not.toBeNull()
    expect(stampedAfterFirst[0]!.resolved_by_actor).toBe(actorId)
    const resolvedAtAfterFirst = stampedAfterFirst[0]!.resolved_at

    // replay with the SAME clientKey: the E6 inbox skips the effect body
    // entirely, so this must be an unambiguous no-op, not a fresh ingest
    // outcome and not a re-stamp.
    const replayActorId = randomUUID()
    const replay = await resolveQuarantineRow(db, {
      quarantineId,
      correctedRow,
      clientKey,
      actorId: replayActorId,
      traceId: 't6',
    })
    expect(replay.deduped).toBe(true)
    expect(replay.outcome).toBeNull()

    const pend = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pending_row WHERE correlation_id = 'corrected-file-2|1'`
    expect(Number(pend[0]!.n)).toBe(1)

    const stampedAfterReplay = await db.$queryRaw<{ resolved_at: Date | null; resolved_by_actor: string | null }[]>`
      SELECT resolved_at, resolved_by_actor FROM quarantine_row WHERE id = ${quarantineId}::uuid
    `
    expect(stampedAfterReplay[0]!.resolved_at).toEqual(resolvedAtAfterFirst)
    expect(stampedAfterReplay[0]!.resolved_by_actor).toBe(actorId)
  })

  it('readQuarantineQueue returns open rows by default, and open+resolved with includeResolved', async () => {
    await db.$executeRaw`
      INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
      VALUES ('q-file', 1, ${'redacted:bank_request'}, 'invalid_qr_vpa_format')
    `
    const resolvedRow = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
      VALUES ('q-file', 2, ${'redacted:bank_request'}, 'missing_contact_name')
      RETURNING id
    `
    const resolvedId = resolvedRow[0]!.id
    const actorId = randomUUID()
    await db.$executeRaw`UPDATE quarantine_row SET resolved_at = now(), resolved_by_actor = ${actorId}::uuid WHERE id = ${resolvedId}::uuid`

    const open = await readQuarantineQueue(db, { includeResolved: false })
    expect(open).toHaveLength(1)
    expect(open[0]!.rowNo).toBe(1)
    expect(open[0]!.resolvedAt).toBeNull()

    const all = await readQuarantineQueue(db, { includeResolved: true })
    expect(all).toHaveLength(2)
    const resolvedView = all.find((x) => x.id === resolvedId)
    expect(resolvedView).toBeDefined()
    expect(resolvedView!.resolvedAt).not.toBeNull()
    expect(resolvedView!.resolvedByActor).toBe(actorId)
    expect(resolvedView!.reasonCode).toBe('missing_contact_name')
    expect(resolvedView!.fileId).toBe('q-file')
  })
})
