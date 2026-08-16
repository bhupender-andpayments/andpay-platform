import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import { advanceShipmentStatus, PrismaClient as FulfillmentClient } from '@andpay/fulfillment-service'
import { projectShipmentToCases, PrismaClient as TmsClient } from '@andpay/tms-service'

// Root-only integration seam (like tms_identity_roundtrip.test.ts): the ONE
// place allowed to import both contexts, because what it proves is a
// cross-context CONTRACT. REVIEW_REPORT.md F1: the D-24 collateral case close
// consumes fct.fulfillment.shipment.v1 and keys on `DELIVERED && asgnIds`,
// and before the F1 fix NO transition emitter populated asgnIds, so the
// per-context suites were green while the end-to-end path was dead (each side
// tested against a hand-built envelope). This test drives the REAL emitter
// and feeds its REAL outbox envelope to the REAL consumer, so the contract
// cannot silently drift again in either direction.

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const fulfillment = new FulfillmentClient({ datasources: { db: { url: fulfillmentUrl } } })
const tms = new TmsClient({ datasources: { db: { url: tmsUrl } } })

beforeEach(async () => {
  await fulfillment.$executeRawUnsafe('TRUNCATE shpt_status_event, shpt, pending_pool_entry, outbox, inbox CASCADE')
  await tms.$executeRawUnsafe('TRUNCATE assignment, outbox, inbox CASCADE')
})
afterAll(async () => {
  await fulfillment.$executeRawUnsafe('TRUNCATE shpt_status_event, shpt, pending_pool_entry, outbox, inbox CASCADE')
  await tms.$executeRawUnsafe('TRUNCATE assignment, outbox, inbox CASCADE')
  await fulfillment.$disconnect()
  await tms.$disconnect()
})

const TENANT = toUuid(newId('tnnt'))
const PROGRAM = toUuid(newId('prog'))

async function seedTmsAssignment(opts: {
  group: 'SOUNDBOX' | 'COLLATERAL'
  replacementOf?: string
  caseStatus?: string
}): Promise<string> {
  const asgnUuid = toUuid(newId('asgn'))
  await tms.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox,
    standee_count, sticker_count, billable, demand_state, source_event_id, dispatch_group,
    replacement_of, case_status, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${PROGRAM}::uuid, ${TENANT}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street', 'upi://pay', 'acme@hdfcbank',
    ${opts.group === 'SOUNDBOX'}, ${opts.group === 'SOUNDBOX' ? 0 : 1}, ${opts.group === 'SOUNDBOX' ? 0 : 2},
    ${opts.replacementOf === undefined}, 'pooled-for-fulfillment', ${`e2e|${asgnUuid}`}, ${opts.group},
    ${opts.replacementOf ?? null}::uuid, ${opts.caseStatus ?? null}, now()
  )`
  return asgnUuid
}

async function caseStatusOf(asgnUuid: string): Promise<string | null> {
  const rows = await tms.$queryRaw<{ case_status: string | null }[]>`
    SELECT case_status FROM assignment WHERE id = ${asgnUuid}::uuid
  `
  return rows[0]!.case_status
}

describe('D-24 collateral close, emitter to consumer (REVIEW_REPORT.md F1)', () => {
  it('a real DELIVERED transition on the collateral parcel closes the replacement case end to end', async () => {
    // TMS: a COLLATERAL parent and its flagged replacement child, case Open.
    const parentUuid = await seedTmsAssignment({ group: 'COLLATERAL' })
    const childUuid = await seedTmsAssignment({ group: 'COLLATERAL', replacementOf: parentUuid, caseStatus: 'Open' })

    // FULFILLMENT: the child's collateral consignment, in transit.
    const shptUuid = toUuid(newId('shpt'))
    const awb = `AWB-E2E-${newId('shpt').slice(-6)}`
    await fulfillment.$executeRaw`
      INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
      VALUES (${shptUuid}::uuid, ${awb}, NULL, 'IN_TRANSIT', now(), ${TENANT}::uuid, ${PROGRAM}::uuid, now())
    `
    await fulfillment.$executeRaw`
      INSERT INTO pending_pool_entry (
        asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
        merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
        ship_to_address, qr_value, vpa_value, pool_status, source_event_id, trace_id,
        dispatch_group, collateral_shipment, created_at, updated_at
      ) VALUES (
        ${childUuid}::uuid, ${TENANT}::uuid, ${PROGRAM}::uuid, false, 1, 2, false,
        'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
        'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'BATCHED', ${`e2e-pool|${childUuid}`}, 't-e2e',
        'COLLATERAL', ${shptUuid}::uuid, now(), now()
      )
    `

    // The REAL emitter: the courier reports DELIVERED.
    const outcome = await fulfillment.$transaction((tx) =>
      advanceShipmentStatus(tx as never, {
        awb,
        status: 'DELIVERED',
        courierTimestamp: new Date('2026-08-16T12:00:00.000Z'),
        source: 'BATCH_FILE',
        sourceRef: 'vndr_e2e|file-1',
        traceId: 't-e2e',
      }),
    )
    expect(outcome).toBe('advanced')

    // The REAL envelope, exactly as the relay would publish it.
    const facts = await fulfillment.$queryRaw<{ payload: Envelope }[]>`
      SELECT payload FROM outbox WHERE event_type = 'fct.fulfillment.shipment.v1' ORDER BY created_at DESC LIMIT 1
    `
    const envelope = facts[0]!.payload
    expect((envelope.payload as { asgnIds?: string[] }).asgnIds).toEqual([fromUuid('asgn', childUuid)])

    // The REAL consumer closes the case.
    await projectShipmentToCases(tms, envelope as never)
    expect(await caseStatusOf(childUuid)).toBe('Closed')
    // The parent is not a replacement and is untouched.
    expect(await caseStatusOf(parentUuid)).toBeNull()
  })
})
