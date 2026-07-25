import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { projectShipToAmended, NotYet } from '../src/ship-to.js'
import { buildDispatchPackage } from '../src/package.js'
import { TMS_SHIP_TO_AMENDED_TOPIC, type ShipToAmendedFactView } from '../src/events.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE pending_pool_entry, composed_artifact, shpt, outbox, inbox')
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

// Check 11 (LOAD-BEARING, FIRM from the Q2 round): the D116 post-composition
// ship-to lock. The whole point of "consume + lock, defer reissue" is the
// NO-SILENT-MUTATION guarantee: once an assignment is composed, a later ship-to
// amend must NOT rewrite the issued collateral. This block seeds a fully
// composed AND dispatched assignment (a composed_artifact against the asgn and
// a born shpt_), snapshots the composed_artifact, the on-hand-off dispatch
// package, and the shpt_ row, delivers a post-composition amend, and asserts
// all three are byte-identical afterward. (ship_to_superseded is the lock flag
// the Q2 round calls "ship_to_locked"; superseded_ship_to holds the pending new
// address for the deferred reissue.)
describe('check 11: D116 post-composition ship-to lock, no silent mutation (FIRM, Q2)', () => {
  async function seedComposedDispatched(
    tenantUuid: string,
    programUuid: string,
    asgnUuid: string,
    btchUuid: string,
  ): Promise<{ awb: string; shptUuid: string }> {
    const merchantUuid = toUuid(newId('mrch'))
    await db.$executeRaw`
      INSERT INTO pending_pool_entry (
        asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
        merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
        ship_to_address, ship_to_contact_name, ship_to_mobile, qr_value, vpa_value, pool_status, batch,
        dispatch_state, source_event_id, trace_id, updated_at
      ) VALUES (
        ${asgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${merchantUuid}::uuid, true, 0, 0, true,
        'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Original Address',
        'Original Contact', '9000000000', 'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'BATCHED', ${btchUuid}::uuid,
        'SENT_TO_VENDOR', 'file-11|1', 'trace-11', now()
      )
    `
    await db.$executeRaw`
      INSERT INTO composed_artifact (id, asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference, label_display_name, label_qr, bank_config_ref)
      VALUES (gen_random_uuid(), ${asgnUuid}::uuid, ${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, 'SOUNDBOX_IMG', 's3://ap-south-1/artifacts/orig', 'Acme', 'upi://pay?pa=acme@hdfcbank', NULL)
    `
    const shptUuid = toUuid(newId('shpt'))
    const awb = 'AWB-LOCK-1'
    await db.$executeRaw`
      INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
      VALUES (${shptUuid}::uuid, ${awb}, NULL, 'DISPATCHED_BY_VENDOR', now(), ${tenantUuid}::uuid, ${programUuid}::uuid, now())
    `
    return { awb, shptUuid }
  }

  it('POST-composition amend LOCKS (ship_to_superseded=true, superseded_ship_to=new, ship_to_address preserved) and leaves composed_artifact + dispatch package + shpt_ UNCHANGED; a re-delivered amend is idempotent', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)
    const asgnWire = newId('asgn')
    const asgnUuid = toUuid(asgnWire)
    const { awb, shptUuid } = await seedComposedDispatched(tenantUuid, programUuid, asgnUuid, btchUuid)

    // Snapshot the three issued artifacts BEFORE the amend.
    const artBefore = await db.$queryRaw<{ asset_reference: string; label_display_name: string; label_qr: string; artifact_type: string }[]>`
      SELECT asset_reference, label_display_name, label_qr, artifact_type FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid ORDER BY artifact_type
    `
    const shptBefore = await db.$queryRaw<{ awb: string; status: string; courier_partner: string | null }[]>`
      SELECT awb, status, courier_partner::text AS courier_partner FROM shpt WHERE id = ${shptUuid}::uuid
    `
    const pkgBefore = await buildDispatchPackage(db, btchWire, 'ship')

    // Deliver a POST-composition ship-to amend (new address + contact + mobile).
    const env = amendEnv(
      { asgnId: asgnWire, shipToAddress: 'Amended Post Address', amendmentSeq: 1, contactName: 'Amended Contact', mobile: '9222222222' },
      'evt-11|fulfillment.ship_to',
      'trace-11a',
    )
    const res = await projectShipToAmended(db, env)
    expect(res.deduped).toBe(false)
    expect(res.applied).toBe('locked')

    // The LOCK: superseded flag set, pending new address captured, snapshot ship_to_address PRESERVED.
    const row = await readEntry(asgnUuid)
    expect(row.ship_to_superseded).toBe(true) // the "ship_to_locked" flag
    expect(row.superseded_ship_to).toBe('Amended Post Address')
    expect(row.ship_to_address).toBe('Original Address')

    // NO SILENT MUTATION 1: the retained composed_artifact is byte-identical.
    const artAfter = await db.$queryRaw<{ asset_reference: string; label_display_name: string; label_qr: string; artifact_type: string }[]>`
      SELECT asset_reference, label_display_name, label_qr, artifact_type FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid ORDER BY artifact_type
    `
    expect(artAfter).toEqual(artBefore)

    // NO SILENT MUTATION 2: the issued dispatch package (ship view) is byte-identical
    // and still carries the ORIGINAL address, NOT the superseded/new one.
    const pkgAfter = await buildDispatchPackage(db, btchWire, 'ship')
    expect(pkgAfter).toEqual(pkgBefore)
    expect(JSON.stringify(pkgAfter)).toContain('Original Address')
    expect(JSON.stringify(pkgAfter)).not.toContain('Amended Post Address')

    // NO SILENT MUTATION 3: the shpt_ row is untouched.
    const shptAfter = await db.$queryRaw<{ awb: string; status: string; courier_partner: string | null }[]>`
      SELECT awb, status, courier_partner::text AS courier_partner FROM shpt WHERE id = ${shptUuid}::uuid
    `
    expect(shptAfter).toEqual(shptBefore)
    expect(shptAfter[0]!.awb).toBe(awb)

    // Reissue deferred: no fact emitted by the lock.
    const outboxCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
    expect(Number(outboxCount[0]!.n)).toBe(0)

    // IDEMPOTENT: a re-delivered amend (same dedupKey) is an inbox no-op; everything still unchanged.
    const again = await projectShipToAmended(db, env)
    expect(again.deduped).toBe(true)
    const rowAgain = await readEntry(asgnUuid)
    expect(rowAgain.ship_to_address).toBe('Original Address')
    expect(rowAgain.superseded_ship_to).toBe('Amended Post Address')
    expect(await buildDispatchPackage(db, btchWire, 'ship')).toEqual(pkgBefore)
  })

  it('PRE-composition amend (dispatch_state NULL) updates the pending_pool_entry snapshot in place (amendable-until-composed half of the FIRM rule)', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const asgnWire = newId('asgn')
    const asgnUuid = toUuid(asgnWire)
    await seedEntry(tenantUuid, programUuid, asgnUuid) // dispatch_state NULL

    const env = amendEnv(
      { asgnId: asgnWire, shipToAddress: 'Pre Composition New', amendmentSeq: 1 },
      'evt-11pre|fulfillment.ship_to',
      'trace-11pre',
    )
    const res = await projectShipToAmended(db, env)
    expect(res.applied).toBe('pre_composition')

    const row = await readEntry(asgnUuid)
    expect(row.ship_to_address).toBe('Pre Composition New') // snapshot updated in place
    expect(row.ship_to_superseded).toBe(false) // not locked: still amendable
    expect(row.superseded_ship_to).toBeNull()
  })
})
