import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { createAssignmentFromEnrollment, type EnrollmentFactView } from '../src/assignment.js'
import { TMS_ASSIGNMENT_TOPIC, type AssignmentFactPayload } from '../src/events.js'
import { TMS_FACT_SCHEMAS } from '../src/fact-schemas.js'

// W-5: the dispatch group rides the fct.tms.assignment.v1 wire fact, one fact
// per dispatch group, optional field (D120 FULL compat). Setup style copied
// from Task 2's per-group-minting.test.ts.

const url =
  process.env.TMS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE assignment, assignment_activation_event, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
})

afterAll(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE assignment, assignment_activation_event, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
  await db.$disconnect()
})

async function seed(
  correlationId: string,
  mix: { soundbox: boolean; standeeCount: number; stickerCount: number },
) {
  const mrchId = fromUuid('mrch', toUuid(newId('mrch')))
  const progId = fromUuid('prog', toUuid(newId('prog')))
  const tnntId = fromUuid('tnnt', toUuid(newId('tnnt')))
  await db.$executeRaw`INSERT INTO pending_row (correlation_id, tenant_reference, soundbox, standee_count, sticker_count, qr_value, vpa_value, ship_to_address, contact_name, mobile, branch_code, status)
    VALUES (${correlationId}, 'HDFC', ${mix.soundbox}, ${mix.standeeCount}, ${mix.stickerCount}, 'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', '221B Baker Street', 'Jane Doe', '+91-9000000000', 'BR-001', 'awaiting-identity')`
  await db.$executeRaw`INSERT INTO merchant_projection (id, display_name, legal_name, mcc, status, updated_at)
    VALUES (${toUuid(mrchId)}::uuid, 'Acme', 'Acme Pvt Ltd', '5814', 'ACTIVE', now())`
  await db.$executeRaw`INSERT INTO tenant_projection (id, display_name, bank_reference_code, updated_at)
    VALUES (${toUuid(tnntId)}::uuid, 'HDFC Bank', 'HDFC', now())`
  return { mrchId, progId, tnntId }
}

function enrollmentEnv(
  ids: { mrchId: string; progId: string; tnntId: string },
  correlationId: string,
  dedupKey = 'evt-f|identity.enrollment',
): Envelope<EnrollmentFactView> {
  return newEnvelope({
    type: 'fct.identity.enrollment.v1', version: 1, subject: ids.mrchId,
    dedupKey, traceId: 'trace-f',
    payload: { enrollmentId: 'enr-1', mrchId: ids.mrchId, progId: ids.progId, tnntId: ids.tnntId, status: 'ACTIVE', sourceEventId: correlationId },
  })
}

describe('assignment fact carries dispatchGroup (W-5)', () => {
  it('a two-group row emits two facts, each stamped with its own dispatchGroup and counts', async () => {
    const ids = await seed('fact-1|1', { soundbox: true, standeeCount: 2, stickerCount: 3 })
    const res = await createAssignmentFromEnrollment(db, enrollmentEnv(ids, 'fact-1|1'))
    expect(res.created).toBe(true)
    expect(res.asgnIds).toHaveLength(2)

    const rows = await db.$queryRaw<{ payload: unknown }[]>`
      SELECT payload FROM outbox WHERE event_type = ${TMS_ASSIGNMENT_TOPIC} ORDER BY created_at
    `
    expect(rows).toHaveLength(2)

    const payloads = rows.map((r) => {
      const env = r.payload as Envelope<AssignmentFactPayload>
      return env.payload
    })

    const soundboxFact = payloads.find((p) => p.dispatchGroup === 'SOUNDBOX')!
    const collateralFact = payloads.find((p) => p.dispatchGroup === 'COLLATERAL')!

    expect(soundboxFact).toBeDefined()
    expect(soundboxFact.standeeCount).toBe(0)
    expect(soundboxFact.stickerCount).toBe(0)

    expect(collateralFact).toBeDefined()
    expect(collateralFact.standeeCount).toBe(2)
    expect(collateralFact.stickerCount).toBe(3)
  })

  it('schema: dispatchGroup is an optional string enum, required stays exactly [asgnId, demandState]', () => {
    const schema = TMS_FACT_SCHEMAS['fct.tms.assignment.v1'] as {
      properties: { dispatchGroup?: { type: string; enum: string[] } }
      required: string[]
    }
    expect(schema.properties.dispatchGroup).toEqual({ type: 'string', enum: ['SOUNDBOX', 'COLLATERAL'] })
    expect(schema.required).toEqual(['asgnId', 'demandState'])
  })
})
