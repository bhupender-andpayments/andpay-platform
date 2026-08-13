import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '../generated/client/index.js'
import { readAssignments, readAssignmentById } from '../src/read.js'

const url =
  process.env.TMS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE assignment, assignment_activation_event, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
})
afterAll(async () => { await db.$disconnect() })

interface Seeded {
  idA: string
  idB: string
  progA: string
  progB: string
}

// Seeds one assignment row per Program (A and B), each with every NOT NULL
// column populated, plus the Fork-F ship-to recipient PII (contact_name,
// mobile, ship_to_address).
async function seed(): Promise<Seeded> {
  const idA = randomUUID()
  const idB = randomUUID()
  const mrchA = randomUUID()
  const mrchB = randomUUID()
  const progA = randomUUID()
  const progB = randomUUID()
  const tnntA = randomUUID()
  const tnntB = randomUUID()

  await db.$executeRaw`
    INSERT INTO assignment (
      id, merchant_id, program_id, tenant_id,
      merchant_display_name, merchant_legal_name, merchant_mcc,
      bank_reference_code, bank_display_name, ship_to_address,
      contact_name, mobile, qr_value, vpa_value,
      soundbox, standee_count, sticker_count, billable,
      demand_state, source_event_id, dispatch_group, updated_at
    ) VALUES (
      ${idA}::uuid, ${mrchA}::uuid, ${progA}::uuid, ${tnntA}::uuid,
      'Acme A', 'Acme A Pvt Ltd', '5814',
      'HDFC', 'HDFC Bank', '221B Baker Street, Program A',
      'Jane Doe', '+91-9000000001', 'upi://pay?pa=acmea@hdfcbank', 'acmea@hdfcbank',
      true, 1, 2, true,
      'pooled-for-fulfillment', 'file-A|1', 'SOUNDBOX', now()
    )
  `
  await db.$executeRaw`
    INSERT INTO assignment (
      id, merchant_id, program_id, tenant_id,
      merchant_display_name, merchant_legal_name, merchant_mcc,
      bank_reference_code, bank_display_name, ship_to_address,
      contact_name, mobile, qr_value, vpa_value,
      soundbox, standee_count, sticker_count, billable,
      demand_state, source_event_id, dispatch_group, updated_at
    ) VALUES (
      ${idB}::uuid, ${mrchB}::uuid, ${progB}::uuid, ${tnntB}::uuid,
      'Acme B', 'Acme B Pvt Ltd', '5815',
      'ICICI', 'ICICI Bank', '42 Wallaby Way, Program B',
      'John Roe', '+91-9000000002', 'upi://pay?pa=acmeb@icicibank', 'acmeb@icicibank',
      false, 0, 1, true,
      'received', 'file-B|1', 'COLLATERAL', now()
    )
  `
  return { idA, idB, progA, progB }
}

describe('tenant read API: readAssignments / readAssignmentById (spec 10b, D-6)', () => {
  it('readAssignments(db,[A]) returns only A\'s row, with the DTO shape incl ship-to PII', async () => {
    const { idA, progA } = await seed()
    const rows = await readAssignments(db, [progA])
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.id).toBe(idA)
    expect(r.programId).toBe(progA)
    expect(r.merchantDisplayName).toBe('Acme A')
    expect(r.bankDisplayName).toBe('HDFC Bank')
    expect(r.bankReferenceCode).toBe('HDFC')
    expect(r.shipToAddress).toBe('221B Baker Street, Program A')
    expect(r.contactName).toBe('Jane Doe')
    expect(r.mobile).toBe('+91-9000000001')
    expect(r.demandState).toBe('pooled-for-fulfillment')
    expect(r.soundbox).toBe(true)
    expect(r.standeeCount).toBe(1)
    expect(r.stickerCount).toBe(2)
    expect(r.activatedAt).toBeNull()
    expect(r.createdAt).toBeInstanceOf(Date)
    expect(r.updatedAt).toBeInstanceOf(Date)
  })

  it('readAssignments(db,[]) returns [] (fail-closed empty scope)', async () => {
    await seed()
    const rows = await readAssignments(db, [])
    expect(rows).toEqual([])
  })

  it('readAssignmentById(db,[A], idB) returns null: B is out of scope', async () => {
    const { idB, progA } = await seed()
    const row = await readAssignmentById(db, [progA], idB)
    expect(row).toBeNull()
  })

  it('readAssignmentById(db,[A], idA) returns A\'s row', async () => {
    const { idA, progA } = await seed()
    const row = await readAssignmentById(db, [progA], idA)
    expect(row).not.toBeNull()
    expect(row!.id).toBe(idA)
    expect(row!.contactName).toBe('Jane Doe')
    expect(row!.mobile).toBe('+91-9000000001')
    expect(row!.shipToAddress).toBe('221B Baker Street, Program A')
  })

  it('readAssignmentById(db,[], idA) returns null (fail-closed empty scope, detail variant)', async () => {
    const { idA } = await seed()
    const row = await readAssignmentById(db, [], idA)
    expect(row).toBeNull()
  })

  it('no-aggregate guard: read.ts contains no count(/group by(/sum( (check 7)', () => {
    const text = readFileSync('services/tms/src/read.ts', 'utf8')
    expect(/\b(count|group\s+by|sum)\s*\(/i.test(text)).toBe(false)
  })

  it('C4 guard: read.ts references no other context (no "services/" substring)', () => {
    const text = readFileSync('services/tms/src/read.ts', 'utf8')
    expect(text.includes('services/')).toBe(false)
  })
})
