import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import type { Envelope } from '@andpay/envelope'
import { ingestRequestRow, projectMerchantFact, projectTenantFact, createAssignmentFromEnrollment, PrismaClient as TmsClient } from '@andpay/tms-service'
import { projectRowFact, PrismaClient as IdentityClient } from '@andpay/identity-service'

// Root-only integration seam (this file is under test/, not services/<ctx>, so
// the cross-schema guard, test/architecture.test.ts, never scans it). This is
// the ONE place in the repo allowed to import both services: it is the runtime
// proof that TMS's row fact and Identity's consumer stay bound with no drift
// (check 1), and that TMS creates its assignment from its OWN projections with
// no Identity db handle (check 2, no C4 read).
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const idUrl = process.env.IDENTITY_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity'
const tms = new TmsClient({ datasourceUrl: tmsUrl })
const identity = new IdentityClient({ datasourceUrl: idUrl })

beforeEach(async () => {
  await tms.$executeRawUnsafe('TRUNCATE assignment, assignment_activation_event, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox')
  await identity.$executeRawUnsafe('TRUNCATE sub_merchant, merchant, merchant_bank_ref, tenant, program, enrollment, outbox, inbox')
})
afterAll(async () => { await tms.$disconnect(); await identity.$disconnect() })

// Drain the tms outbox and return decoded envelopes by topic.
async function tmsFacts(): Promise<Envelope[]> {
  const rows = await tms.$queryRaw<{ payload: unknown }[]>`SELECT payload FROM outbox ORDER BY created_at`
  return rows.map((r) => r.payload as Envelope)
}
async function identityFacts(): Promise<Envelope[]> {
  const rows = await identity.$queryRaw<{ payload: unknown }[]>`SELECT payload FROM outbox ORDER BY created_at`
  return rows.map((r) => r.payload as Envelope)
}

describe('TMS-thin to Identity-min round trip (checks 1, 2)', () => {
  it('ingest -> real Identity consumer -> projections -> join creates one assignment with projection-sourced snapshot', async () => {
    // 1. TMS ingests a request row and emits the row fact.
    const outcome = await ingestRequestRow(tms, {
      fileId: 'file-1', rowNo: 1, bankMerchantReference: 'BM-1', displayName: 'Acme', legalName: 'Acme Pvt Ltd',
      mcc: '5814', registeredAddress: '221B Baker Street', bankReferenceCode: '3', productType: 'soundbox',
      vpaValue: 'acme@hdfcbank', qrValue: 'upi://pay?pa=acme@hdfcbank', soundbox: true, standeeCount: 1, stickerCount: 2,
      shipToAddress: '221B Baker Street', contactName: 'Jane Doe', mobile: '9000000000', branchCode: '30', vpaHint: 'acme@hdfcbank',
    }, 'trace-1')
    expect(outcome).toBe('accepted')

    const [rowFact] = await tmsFacts()
    expect(rowFact!.type).toBe('fct.tms.bank_file_row.v1')

    // 2. The REAL Identity consumer processes the row fact (no schema drift:
    // Identity's projectRowFact accepts the TMS-produced envelope structurally).
    const idResult = await projectRowFact(identity, rowFact as never)
    expect(idResult.deduped).toBe(false)

    // 3. TMS projects the merchant and tenant facts Identity emitted, then joins
    // the enrollment fact to create the assignment.
    const idFacts = await identityFacts()
    const merchantFact = idFacts.find((f) => f.type === 'fct.identity.merchant.v1')!
    const tenantFact = idFacts.find((f) => f.type === 'fct.identity.tenant.v1')!
    const enrollmentFact = idFacts.find((f) => f.type === 'fct.identity.enrollment.v1')!
    expect(merchantFact && tenantFact && enrollmentFact).toBeTruthy()

    await projectMerchantFact(tms, merchantFact as never)
    await projectTenantFact(tms, tenantFact as never)
    const asgnRes = await createAssignmentFromEnrollment(tms, enrollmentFact as never)
    expect(asgnRes.created).toBe(true)
    // this row is soundbox=true with nonzero standee/sticker counts, so it
    // deserves TWO dispatch groups (W-5): SOUNDBOX and COLLATERAL.
    expect(asgnRes.asgnIds).toHaveLength(2)

    // 4. One assignment PER dispatch group, snapshot sourced from the TMS
    // projection (check 2, no C4 read), correlation join on {file_id}|{row_no}.
    const asgn = await tms.$queryRaw<{ merchant_display_name: string; bank_reference_code: string; ship_to_address: string; source_event_id: string; dispatch_group: string }[]>`
      SELECT merchant_display_name, bank_reference_code, ship_to_address, source_event_id, dispatch_group FROM assignment ORDER BY dispatch_group
    `
    expect(asgn).toHaveLength(2)
    expect(asgn.map((a) => a.dispatch_group)).toEqual(['COLLATERAL', 'SOUNDBOX'])
    for (const row of asgn) {
      expect(row.merchant_display_name).toBe('Acme')     // from merchant_projection <- fct.identity.merchant.v1
      expect(row.bank_reference_code).toBe('3')       // from tenant_projection
      expect(row.ship_to_address).toBe('221B Baker Street')
      expect(row.source_event_id).toBe('file-1|1')       // correlation join
    }

    // the enrollment fact carried the row's correlation id as sourceEventId
    expect((enrollmentFact.payload as { sourceEventId: string }).sourceEventId).toBe('file-1|1')
  })
})
