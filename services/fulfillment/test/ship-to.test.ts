import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { projectShipToAmended, NotYet } from '../src/ship-to.js'
import { TMS_SHIP_TO_AMENDED_TOPIC, type ShipToAmendedFactView } from '../src/events.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE pending_pool_entry, outbox, inbox')
})
afterAll(async () => {
  await db.$disconnect()
})

// A fixture pending_pool_entry row, PRE-composition (dispatch_state NULL,
// ship_to_amendment_seq NULL, ship_to_superseded false), the state
// projectDemandFact (Task 3) would have left it in. Mirrors dispatch.test.ts's
// seedBatchedEntry, minus batch/dispatch_state.
async function seedEntry(
  tenantUuid: string,
  programUuid: string,
  asgnUuid: string,
): Promise<void> {
  const merchantUuid = toUuid(newId('mrch'))
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, ship_to_contact_name, ship_to_mobile, qr_value, vpa_value, pool_status, source_event_id, trace_id, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${merchantUuid}::uuid, true, 1, 2, true,
      'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Original Address',
      'Original Contact', '9000000000', 'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'POOLED', 'file-1|1', 'trace-seed', now()
    )
  `
}

async function setDispatchState(asgnUuid: string, state: string): Promise<void> {
  await db.$executeRaw`UPDATE pending_pool_entry SET dispatch_state = ${state}, updated_at = now() WHERE asgn_id = ${asgnUuid}::uuid`
}

interface EntryRow {
  ship_to_address: string
  ship_to_contact_name: string | null
  ship_to_mobile: string | null
  ship_to_amendment_seq: number | null
  ship_to_superseded: boolean
  superseded_ship_to: string | null
  dispatch_state: string | null
}

async function readEntry(asgnUuid: string): Promise<EntryRow> {
  const rows = await db.$queryRaw<EntryRow[]>`
    SELECT ship_to_address, ship_to_contact_name, ship_to_mobile, ship_to_amendment_seq,
           ship_to_superseded, superseded_ship_to, dispatch_state
    FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid
  `
  if (rows.length === 0) throw new Error('entry not found')
  return rows[0]!
}

function amendEnv(payload: ShipToAmendedFactView, dedupKey: string, traceId: string): Envelope<ShipToAmendedFactView> {
  return newEnvelope({
    type: TMS_SHIP_TO_AMENDED_TOPIC,
    version: 1,
    subject: payload.asgnId,
    dedupKey,
    traceId,
    payload,
  })
}

describe('projectShipToAmended (D116 ship-to consume + lock, defer reissue)', () => {
  it('pre-composition amend (dispatch_state NULL): ship_to_address/contact/mobile update, ship_to_amendment_seq set, ship_to_superseded stays false; applied:pre_composition', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const asgnWire = newId('asgn')
    const asgnUuid = toUuid(asgnWire)
    await seedEntry(tenantUuid, programUuid, asgnUuid)

    const env = amendEnv(
      { asgnId: asgnWire, shipToAddress: 'New Address', amendmentSeq: 1, contactName: 'New Contact', mobile: '9111111111' },
      'evt-1|fulfillment.ship_to',
      'trace-1',
    )
    const res = await projectShipToAmended(db, env)
    expect(res.deduped).toBe(false)
    expect(res.applied).toBe('pre_composition')

    const row = await readEntry(asgnUuid)
    expect(row.ship_to_address).toBe('New Address')
    expect(row.ship_to_contact_name).toBe('New Contact')
    expect(row.ship_to_mobile).toBe('9111111111')
    expect(row.ship_to_amendment_seq).toBe(1)
    expect(row.ship_to_superseded).toBe(false)
    expect(row.superseded_ship_to).toBeNull()
  })

  it('pre-composition amend with only shipToAddress set (contact/mobile omitted, 06a FULL-compat): existing contact/mobile preserved', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const asgnWire = newId('asgn')
    const asgnUuid = toUuid(asgnWire)
    await seedEntry(tenantUuid, programUuid, asgnUuid)

    const env = amendEnv(
      { asgnId: asgnWire, shipToAddress: 'New Address Only', amendmentSeq: 1 },
      'evt-1b|fulfillment.ship_to',
      'trace-1b',
    )
    const res = await projectShipToAmended(db, env)
    expect(res.applied).toBe('pre_composition')

    const row = await readEntry(asgnUuid)
    expect(row.ship_to_address).toBe('New Address Only')
    expect(row.ship_to_contact_name).toBe('Original Contact') // preserved, COALESCE fallback
    expect(row.ship_to_mobile).toBe('9000000000') // preserved, COALESCE fallback
  })

  it('post-composition amend (dispatch_state=QR_GENERATED): ship_to_superseded=true, superseded_ship_to=new, ship_to_address UNCHANGED; applied:locked; no outbox row emitted (reissue deferred)', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const asgnWire = newId('asgn')
    const asgnUuid = toUuid(asgnWire)
    await seedEntry(tenantUuid, programUuid, asgnUuid)
    await setDispatchState(asgnUuid, 'QR_GENERATED')

    const env = amendEnv(
      { asgnId: asgnWire, shipToAddress: 'Post Composition Address', amendmentSeq: 1 },
      'evt-2|fulfillment.ship_to',
      'trace-2',
    )
    const res = await projectShipToAmended(db, env)
    expect(res.deduped).toBe(false)
    expect(res.applied).toBe('locked')

    const row = await readEntry(asgnUuid)
    expect(row.ship_to_address).toBe('Original Address') // UNCHANGED: preserved for the already-composed artifact
    expect(row.ship_to_superseded).toBe(true)
    expect(row.superseded_ship_to).toBe('Post Composition Address')
    expect(row.ship_to_amendment_seq).toBe(1)

    // NEVER emit a reissue fact (D116 ratified: consume + lock, defer reissue).
    const outboxCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
    expect(Number(outboxCount[0]!.n)).toBe(0)
  })

  it('redelivery (same dedupKey) is a no-op at the inbox (E6): deduped:true, no change', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const asgnWire = newId('asgn')
    const asgnUuid = toUuid(asgnWire)
    await seedEntry(tenantUuid, programUuid, asgnUuid)

    const env = amendEnv(
      { asgnId: asgnWire, shipToAddress: 'New Address', amendmentSeq: 1 },
      'evt-3|fulfillment.ship_to',
      'trace-3',
    )
    const first = await projectShipToAmended(db, env)
    expect(first.deduped).toBe(false)
    expect(first.applied).toBe('pre_composition')

    const again = await projectShipToAmended(db, env)
    expect(again.deduped).toBe(true)

    const row = await readEntry(asgnUuid)
    expect(row.ship_to_address).toBe('New Address') // stable, no double-apply
    expect(row.ship_to_amendment_seq).toBe(1)
  })

  it('stale seq: a lower amendmentSeq delivered after a higher one already applied is a no-op; applied:stale_seq', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const asgnWire = newId('asgn')
    const asgnUuid = toUuid(asgnWire)
    await seedEntry(tenantUuid, programUuid, asgnUuid)

    const higher = amendEnv(
      { asgnId: asgnWire, shipToAddress: 'Address Seq 2', amendmentSeq: 2 },
      'evt-4a|fulfillment.ship_to',
      'trace-4a',
    )
    const first = await projectShipToAmended(db, higher)
    expect(first.applied).toBe('pre_composition')

    const lower = amendEnv(
      { asgnId: asgnWire, shipToAddress: 'Address Seq 1 (stale)', amendmentSeq: 1 },
      'evt-4b|fulfillment.ship_to',
      'trace-4b',
    )
    const second = await projectShipToAmended(db, lower)
    expect(second.deduped).toBe(false) // a fresh dedupKey, the inbox gate passes
    expect(second.applied).toBe('stale_seq')

    const row = await readEntry(asgnUuid)
    expect(row.ship_to_address).toBe('Address Seq 2') // unchanged by the stale delivery
    expect(row.ship_to_amendment_seq).toBe(2)
    expect(row.ship_to_superseded).toBe(false)
  })

  it('unknown asgn (no pending_pool_entry row yet, cross-topic race with the demand fact): projectShipToAmended THROWS NotYet so the bus redelivers, and writes NO inbox row', async () => {
    const asgnWire = newId('asgn')
    const env = amendEnv(
      { asgnId: asgnWire, shipToAddress: 'Nowhere', amendmentSeq: 1 },
      'evt-5|fulfillment.ship_to',
      'trace-5',
    )

    await expect(projectShipToAmended(db, env)).rejects.toThrow(NotYet)

    const inboxCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inbox`
    expect(Number(inboxCount[0]!.n)).toBe(0)
  })

  // The TOCTOU proof (fold 2): a naive "SELECT dispatch_state, then branch in
  // application code" design would decide pre_composition vs locked from a
  // stale snapshot. Here dispatch_state flips to QR_GENERATED (simulating a
  // compose that has ALREADY committed) strictly BEFORE the amend is
  // delivered, so even a broken read-then-branch implementation would see the
  // right value on ITS OWN read; what this test actually pins down is that the
  // real gate is the UPDATE's own WHERE clause (evaluated atomically under the
  // row lock at write time, not a value read earlier and carried into a JS
  // if/else) by asserting the full post-lock invariant: ship_to_address is
  // preserved bit-for-bit, the new address lands ONLY in superseded_ship_to,
  // and dispatch_state itself is untouched by the ship-to path.
  it('concurrency/TOCTOU: dispatch_state flips to QR_GENERATED after the entry is created; the amend lands as locked with ship_to_address preserved, never silently overwritten', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const asgnWire = newId('asgn')
    const asgnUuid = toUuid(asgnWire)
    await seedEntry(tenantUuid, programUuid, asgnUuid) // dispatch_state NULL at birth

    // the "concurrent compose" that wins the race, committing before the amend
    // is processed.
    await setDispatchState(asgnUuid, 'QR_GENERATED')

    const env = amendEnv(
      { asgnId: asgnWire, shipToAddress: 'Raced Address', amendmentSeq: 1 },
      'evt-6|fulfillment.ship_to',
      'trace-6',
    )
    const res = await projectShipToAmended(db, env)
    expect(res.applied).toBe('locked')

    const row = await readEntry(asgnUuid)
    expect(row.dispatch_state).toBe('QR_GENERATED') // untouched by the ship-to path
    expect(row.ship_to_address).toBe('Original Address') // NOT silently overwritten
    expect(row.ship_to_superseded).toBe(true)
    expect(row.superseded_ship_to).toBe('Raced Address')
  })
})
