import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, type ProgId } from '@andpay/ids'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { PrismaClient } from '../generated/client/index.js'
import { ingestEnvelope } from '../src/ingest.js'
import type { AssignmentFactView } from '../src/fact-views.js'

// Every connection here is the andpay CLUSTER SUPERUSER, which bypasses RLS by
// superuser status alone; the analytics_write grant boundary and RLS only bite
// once SET LOCAL ROLE analytics_write is in force inside the tx (current_user,
// not session_user, drives the check). SET LOCAL is transaction-scoped, so each
// assertion expecting a permission failure runs in its OWN transaction.
const url =
  process.env.ANALYTICS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const db = new PrismaClient({ datasourceUrl: url })

afterAll(async () => {
  await db.$disconnect()
})

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE analytics.raw_event, analytics.dispatch_row, analytics.inbox, analytics.analytics_watermark CASCADE',
  )
})

// A minimal but fully-typed assignment fact payload; only the ids need to be
// real typed ids (programIdOf decodes progId via toUuid, which requires a valid
// Crockford payload), the snapshot fields are cosmetic for the raw persist.
function assignmentEnvelope(over: { asgnId?: string; progId?: string } = {}): Envelope<AssignmentFactView> {
  const asgnId = over.asgnId ?? newId('asgn')
  const progId = (over.progId ?? newId('prog')) as ProgId
  const payload: AssignmentFactView = {
    asgnId,
    mrchId: newId('mrch'),
    progId,
    tnntId: newId('tnnt'),
    merchantDisplayName: 'Acme',
    merchantLegalName: 'Acme Pvt Ltd',
    merchantMcc: '5814',
    bankReferenceCode: 'HDFC',
    bankDisplayName: 'HDFC Bank',
    shipToAddress: '221B Baker Street',
    qrValue: 'upi://pay?pa=acme@hdfcbank',
    vpaValue: 'acme@hdfcbank',
    soundbox: true,
    standeeCount: 1,
    stickerCount: 0,
    billable: true,
    demandState: 'pooled-for-fulfillment',
    sourceEventId: `file-1|${asgnId}`,
  }
  return newEnvelope({
    type: 'fct.tms.assignment.v1',
    version: 1,
    subject: asgnId,
    dedupKey: `evt-ing|${asgnId}`,
    traceId: 'trace-ing',
    payload,
  })
}

describe('analytics fact ingest: append-only raw_event, inbox dedup, raw-before-model (checks 2, 5)', () => {
  it('persists the fact to raw_event append-only and dedups a redelivery', async () => {
    const env = assignmentEnvelope()
    const first = await ingestEnvelope(db, env)
    expect(first.deduped).toBe(false)
    const again = await ingestEnvelope(db, env) // same envelope_id
    expect(again.deduped).toBe(true) // inbox {envelope_id} no-op
    const raw = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) n FROM analytics.raw_event WHERE envelope_id = ${env.id}`
    expect(Number(raw[0]!.n)).toBe(1) // exactly one raw row, not two
  })

  it('stores the fact identity headers, program uuid, and full payload on the raw row', async () => {
    const env = assignmentEnvelope()
    await ingestEnvelope(db, env)
    const rows = await db.$queryRaw<
      { topic: string; type: string; schema_version: number; aggregate_id: string; program_id: string | null; payload: unknown }[]
    >`SELECT topic, type, schema_version, aggregate_id, program_id::text AS program_id, payload
      FROM analytics.raw_event WHERE envelope_id = ${env.id}`
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.topic).toBe('fct.tms.assignment.v1')
    expect(r.type).toBe('fct.tms.assignment.v1')
    expect(r.schema_version).toBe(1)
    expect(r.aggregate_id).toBe(env.subject)
    expect(r.program_id).not.toBeNull() // assignment carries progId -> uuid
    expect((r.payload as AssignmentFactView).asgnId).toBe(env.payload.asgnId)
  })

  it('a fact carrying no program field lands raw with program_id NULL (unit)', async () => {
    const unitId = newId('unit')
    const env = newEnvelope({
      type: 'fct.fulfillment.unit.v1',
      version: 1,
      subject: unitId,
      dedupKey: `evt-ing|${unitId}`,
      traceId: 'trace-ing',
      payload: { unitId, kind: 'SERIALIZED', productType: 'SOUNDBOX', manufacturerVndr: newId('vndr'), status: 'IN_STOCK' },
    })
    const res = await ingestEnvelope(db, env)
    expect(res.deduped).toBe(false)
    const rows = await db.$queryRaw<{ program_id: string | null }[]>`
      SELECT program_id::text AS program_id FROM analytics.raw_event WHERE envelope_id = ${env.id}`
    expect(rows[0]!.program_id).toBeNull()
  })

  it('bumps the per-topic watermark to the ingested envelope', async () => {
    const env = assignmentEnvelope()
    await ingestEnvelope(db, env)
    const wm = await db.$queryRaw<{ topic: string; envelope_id: string }[]>`
      SELECT topic, envelope_id FROM analytics.analytics_watermark WHERE topic = ${env.type}`
    expect(wm).toHaveLength(1)
    expect(wm[0]!.envelope_id).toBe(env.id)
  })

  it('raw_event rejects UPDATE and DELETE under analytics_write (append-only grant)', async () => {
    await ingestEnvelope(db, assignmentEnvelope())
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE analytics_write')
        await tx.$executeRaw`UPDATE analytics.raw_event SET topic = 'x'`
      }),
    ).rejects.toThrow(/permission denied/)
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE analytics_write')
        await tx.$executeRaw`DELETE FROM analytics.raw_event`
      }),
    ).rejects.toThrow(/permission denied/)
  })

  it('the ingest runs under analytics_write, not owner (current_user BEFORE INSERT trigger)', async () => {
    // A DB-level BEFORE INSERT trigger on raw_event asserting current_user at the
    // moment of the REAL write. The andpay connection is the cluster superuser,
    // which bypasses RLS entirely, so this trigger is what makes the proof
    // NON-VACUOUS: an owner-run write (role NOT entered first) trips the RAISE;
    // only a correctly role-scoped ingest passes silently. Modeled on the
    // fulfillment write_role.test.ts installGuard technique.
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION analytics_assert_aw() RETURNS trigger AS $BODY$
      BEGIN
        IF current_user <> 'analytics_write' THEN
          RAISE EXCEPTION 'spec 11 task 2: expected current_user analytics_write on %, got %', TG_TABLE_NAME, current_user;
        END IF;
        RETURN NEW;
      END;
      $BODY$ LANGUAGE plpgsql;
    `)
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS analytics_aw_trg_raw_event ON analytics.raw_event')
    await db.$executeRawUnsafe(
      'CREATE TRIGGER analytics_aw_trg_raw_event BEFORE INSERT ON analytics.raw_event FOR EACH ROW EXECUTE FUNCTION analytics_assert_aw()',
    )
    try {
      const res = await ingestEnvelope(db, assignmentEnvelope())
      expect(res.deduped).toBe(false)
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS analytics_aw_trg_raw_event ON analytics.raw_event')
    }
  })
})
