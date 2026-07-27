import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { uploadBankFile, uploadDamageFile, resolveQuarantineRow } from '../src/ops.js'
import { readQuarantineQueue } from '../src/ops-read.js'
import type { BankRequestRow } from '../src/ingest.js'
import type { BankDamageRow } from '../src/damage.js'

const url =
  process.env.TMS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE assignment, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
})
afterAll(async () => { await db.$disconnect() })

function validRow(over: Partial<BankRequestRow> = {}): BankRequestRow {
  return {
    fileId: 'file-1', rowNo: 1,
    bankMerchantReference: 'BM-1', displayName: 'Acme', legalName: 'Acme Pvt Ltd',
    mcc: '5814', registeredAddress: '221B Baker Street', bankReferenceCode: 'HDFC',
    productType: 'soundbox', vpaValue: 'acme@hdfcbank', qrValue: 'upi://pay?pa=acme@hdfcbank',
    soundbox: true, standeeCount: 1, stickerCount: 2, shipToAddress: '221B Baker Street',
    contactName: 'Jane Doe', mobile: '+91-9000000000',
    vpaHint: 'acme@hdfcbank', ...over,
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

describe('tms ops API (spec 10c Task 5): uploads under tms_write, quarantine resolution, ops-read', () => {
  it('runs the S8 ingest under tms_write: a valid row posts, a malformed row quarantines', async () => {
    const clientKey = randomUUID()
    const rows: BankRequestRow[] = [
      validRow({ rowNo: 1 }),
      validRow({ rowNo: 2, contactName: '' }),
    ]
    const r = await uploadBankFile(db, { rows, clientKey, actorId: randomUUID(), traceId: 't1' })
    expect(r.accepted).toBe(1)
    expect(r.quarantined).toBe(1)
    expect(r.duplicate).toBe(0)

    const pend = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pending_row`
    expect(Number(pend[0]!.n)).toBe(1)
    const q = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM quarantine_row`
    expect(Number(q[0]!.n)).toBe(1)
  })

  it('is idempotent on the client key: a replay is a no-op (deduped by the E6 inbox)', async () => {
    const clientKey = randomUUID()
    const rows: BankRequestRow[] = [validRow({ rowNo: 1 })]
    const first = await uploadBankFile(db, { rows, clientKey, actorId: randomUUID(), traceId: 't2' })
    const replay = await uploadBankFile(db, { rows, clientKey, actorId: randomUUID(), traceId: 't2' })
    expect(first.accepted).toBe(1)
    expect(replay.accepted).toBe(0)
    expect(replay.quarantined).toBe(0)
    expect(replay.duplicate).toBe(0)

    const pend = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pending_row`
    expect(Number(pend[0]!.n)).toBe(1)
  })

  it('uploadDamageFile runs the damage ingest under tms_write: a matched row replaces, an unmatched row quarantines', async () => {
    await seedOriginalAssignment('acme@hdfcbank', 'HDFC')
    const clientKey = randomUUID()
    const rows: BankDamageRow[] = [
      { fileId: 'dmg-1', rowNo: 1, tenantReference: 'HDFC', vpaValue: 'acme@hdfcbank', damageReason: 'water_damage', bankRemarks: 'replace asap', shipToAddress: 'New Addr' },
      { fileId: 'dmg-1', rowNo: 2, tenantReference: 'HDFC', vpaValue: 'unknown@hdfcbank', damageReason: 'x', bankRemarks: '', shipToAddress: 'A' },
    ]
    const r = await uploadDamageFile(db, { rows, clientKey, actorId: randomUUID(), traceId: 't3' })
    expect(r.replaced).toBe(1)
    expect(r.quarantined).toBe(1)
    expect(r.duplicate).toBe(0)

    const repl = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment WHERE replacement_of IS NOT NULL`
    expect(Number(repl[0]!.n)).toBe(1)
  })

  it('uploadDamageFile is idempotent on the client key (replay is a no-op)', async () => {
    await seedOriginalAssignment('acme@hdfcbank', 'HDFC')
    const clientKey = randomUUID()
    const rows: BankDamageRow[] = [
      { fileId: 'dmg-1', rowNo: 1, tenantReference: 'HDFC', vpaValue: 'acme@hdfcbank', damageReason: 'water_damage', bankRemarks: '', shipToAddress: 'New Addr' },
    ]
    const first = await uploadDamageFile(db, { rows, clientKey, actorId: randomUUID(), traceId: 't4' })
    const replay = await uploadDamageFile(db, { rows, clientKey, actorId: randomUUID(), traceId: 't4' })
    expect(first.replaced).toBe(1)
    expect(replay.replaced).toBe(0)
    expect(replay.quarantined).toBe(0)
    expect(replay.duplicate).toBe(0)
  })

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
