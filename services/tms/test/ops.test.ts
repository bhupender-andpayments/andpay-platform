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
  BankFileParseError,
} from '../src/ops.js'
import { readQuarantineQueue } from '../src/ops-read.js'
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
const PII_MOBILE = '+91-9000000000'

const BASE_REQUEST: Record<string, string> = {
  bankMerchantReference: 'BM-1',
  displayName: 'Acme',
  legalName: 'Acme Pvt Ltd',
  mcc: '5814',
  registeredAddress: '221B Baker Street',
  bankReferenceCode: 'HDFC',
  productType: 'soundbox',
  vpaValue: 'acme@hdfcbank',
  qrValue: 'upi://pay?pa=acme@hdfcbank',
  soundbox: 'true',
  standeeCount: '1',
  stickerCount: '2',
  shipToAddress: '221B Baker Street',
  contactName: PII_CONTACT,
  mobile: PII_MOBILE,
  branchCode: 'BR-001',
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
    'TRUNCATE assignment, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
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
    bankReferenceCode: 'HDFC',
    productType: 'soundbox',
    vpaValue: 'acme@hdfcbank',
    qrValue: 'upi://pay?pa=acme@hdfcbank',
    soundbox: true,
    standeeCount: 1,
    stickerCount: 2,
    shipToAddress: '221B Baker Street',
    contactName: 'Jane Doe',
    mobile: '+91-9000000000',
    branchCode: 'BR-001',
    vpaHint: 'acme@hdfcbank',
    ...over,
  }
}

async function seedOriginalAssignment(vpa: string, bank: string): Promise<string> {
  const asgnUuid = toUuid(newId('asgn'))
  await db.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', ${bank}, 'HDFC Bank', 'Old Addr', 'upi://pay', ${vpa}, true, 1, 2,
    true, 'pooled-for-fulfillment', 'ops-seed|1', now()
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

    const res = await previewBankFile(csv, 'requests.csv')
    expect(res.structuralErrors).toEqual([])
    expect(res.summary).toEqual({ total: 2, valid: 1, invalid: 1 })
    expect(res.rows[0]!.valid).toBe(true)
    expect(res.rows[0]!.errors).toEqual([])
    expect(res.rows[1]!.valid).toBe(false)
    expect(res.rows[1]!.errors).toEqual(['missing_recipient_contact'])
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
      const res = await previewBankFile(xlsx, 'requests.xlsx')
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

    const res = await previewBankFile(csv, 'requests.csv')
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
    expect(Number(repl[0]!.n)).toBe(1)
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

describe('tms ops API (spec 10c Task 5): quarantine resolution, ops-read', () => {
  it('resolveQuarantineRow re-drives ingest and stamps resolved_at/resolved_by_actor without mutating other quarantine state', async () => {
    const seeded = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
      VALUES ('seed-file', 1, ${'redacted:bank_request'}, 'missing_recipient_contact')
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
      VALUES ('seed-file-2', 1, ${'redacted:bank_request'}, 'missing_recipient_contact')
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
      VALUES ('q-file', 2, ${'redacted:bank_request'}, 'missing_recipient_contact')
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
    expect(resolvedView!.reasonCode).toBe('missing_recipient_contact')
    expect(resolvedView!.fileId).toBe('q-file')
  })
})
