import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Envelope } from '@andpay/envelope'
import { ingestRequestRow, projectMerchantFact, projectTenantFact, projectAggregatorFact, createAssignmentFromEnrollment, PrismaClient as TmsClient } from '@andpay/tms-service'
import { projectRowFact, createBankMaster, announceDefaultAggregators, PrismaClient as IdentityClient } from '@andpay/identity-service'

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
  await tms.$executeRawUnsafe('TRUNCATE assignment, pending_row, merchant_projection, tenant_projection, aggregator_projection, ingest_file, quarantine_row, outbox, inbox')
  await identity.$executeRawUnsafe('TRUNCATE aggregator, sub_merchant, merchant, merchant_bank_ref, tenant, program, enrollment, outbox, inbox')
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

// The admin-created bank. resolveTenant AUTO-MINTS a tenant on first sight of a
// bank reference code and emits the tenant fact only on that mint, so the
// happy path above is the AUTO-MINT path: the tenant is born during ingest and
// its fact rides out in the same transaction.
//
// A bank created through POST /ops/bank-masters is born BEFORE any file. When
// the file arrives, resolveTenant RESOLVES it (created: false) and emits
// nothing, because there was no state change to report. Nothing else emits it
// either, so TMS's tenant_projection never gets a row and every assignment for
// that bank's file dies on the projection lookup.
describe('an admin-created bank reaches TMS (the tenant fact on the resolve path)', () => {
  it('projects the tenant and creates the assignment for a bank that existed before its first file', async () => {
    // 1. The bank is created by an admin, through its own route's domain
    // function, with no file anywhere.
    const bank = await createBankMaster(identity, {
      bankReferenceCode: '77',
      displayName: 'Admin Created Bank',
      address1: '1 MG Road',
      city: 'Bengaluru',
      district: 'Bengaluru Urban',
      country: 'India',
      pin: '560001',
      mobile: '9000000001',
      email: 'ops@adminbank.example',
      clientKey: randomUUID(),
      actorId: 'actor-admin-1',
      traceId: 'trace-admin-1',
    })
    expect(bank.tnntId).toMatch(/^tnnt_/)

    // 2. That bank's first request file arrives.
    const outcome = await ingestRequestRow(
      tms,
      {
        fileId: 'file-admin', rowNo: 1, bankMerchantReference: 'BM-ADMIN-1', displayName: 'Late Sheet Traders',
        legalName: 'Late Sheet Traders Pvt Ltd', mcc: '5814', registeredAddress: '9 Station Road',
        bankReferenceCode: '77', productType: 'soundbox', vpaValue: 'late@bank77',
        qrValue: 'upi://pay?pa=late@bank77', soundbox: true, standeeCount: 0, stickerCount: 0,
        shipToAddress: '9 Station Road', contactName: 'Jane Doe', mobile: '9000000000', branchCode: '30',
        vpaHint: 'late@bank77',
      },
      'trace-admin-2',
    )
    expect(outcome).toBe('accepted')

    const [rowFact] = await tmsFacts()
    const idResult = await projectRowFact(identity, rowFact as never)
    expect(idResult.deduped).toBe(false)
    if (idResult.deduped) throw new Error('unreachable')

    // The ingest RESOLVED the admin-created bank rather than minting a second
    // one. That much already worked; it is the reason no fact was emitted.
    expect(idResult.tnntId).toBe(bank.tnntId)

    // 3. A tenant fact must exist for this bank, from whichever path created
    // it. Without one, TMS has no way to learn the bank exists at all.
    const idFacts = await identityFacts()
    const tenantFacts = idFacts.filter((f) => f.type === 'fct.identity.tenant.v1')
    expect(tenantFacts).toHaveLength(1)
    expect((tenantFacts[0]!.payload as { tnntId: string }).tnntId).toBe(bank.tnntId)

    // 4. The whole point: the assignment can be created. Before the fix this
    // threw "tenant projection not ready for <tnntId>" and every row of an
    // admin-created bank's first file was lost.
    const merchantFact = idFacts.find((f) => f.type === 'fct.identity.merchant.v1')!
    const enrollmentFact = idFacts.find((f) => f.type === 'fct.identity.enrollment.v1')!
    await projectMerchantFact(tms, merchantFact as never)
    await projectTenantFact(tms, tenantFacts[0] as never)

    const asgnRes = await createAssignmentFromEnrollment(tms, enrollmentFact as never)
    expect(asgnRes.created).toBe(true)

    const asgn = await tms.$queryRaw<{ bank_reference_code: string; bank_display_name: string }[]>`
      SELECT bank_reference_code, bank_display_name FROM assignment
    `
    expect(asgn).toHaveLength(1)
    // The snapshot carries the ADMIN's display name, not the bank reference
    // code the auto-mint would have used as a placeholder.
    expect(asgn[0]!.bank_display_name).toBe('Admin Created Bank')
  })
})

// THE BACKFILLED DEFAULT AGGREGATOR NEVER REACHED TMS.
//
// 20260820120000_backfill_default_aggregators inserted each pre-existing
// tenant's default aggregator in plain SQL and emitted no fact, by its own
// admission (a migration cannot build an E4 envelope). TMS therefore never
// projected those rows, and on the demo database identity held 95 aggregators
// against 94 projections, the missing one being the tenant's own default.
//
// This is the end-to-end proof that announceDefaultAggregators closes it: the
// gap is reproduced exactly (SQL insert, no fact), then the announcement is
// carried across the same seam every other fact uses.
describe('a default aggregator inserted by the backfill reaches TMS once announced', () => {
  it('goes from unprojected to projected, and stays put on a second announcement', async () => {
    const bank = await createBankMaster(identity, {
      bankReferenceCode: 'BREF-RT-ANN',
      displayName: 'Roundtrip Announce Bank',
      address1: '1 MG Road',
      city: 'Bengaluru',
      district: 'Bengaluru Urban',
      country: 'India',
      pin: '560001',
      mobile: '9000000001',
      email: 'ops@roundtrip.example',
      clientKey: randomUUID(),
      actorId: 'actor-rt',
      traceId: 'trace-rt',
    })

    // Reproduce the backfill's state: the default exists in identity with no
    // fact behind it. createBankMaster does emit one, so clear the outbox and
    // re-insert the row the way the migration did.
    const tenantUuid = (
      await identity.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM tenant`
    )[0]!.id
    await identity.$executeRawUnsafe('TRUNCATE outbox')
    await identity.$executeRaw`DELETE FROM aggregator WHERE tenant_id = ${tenantUuid}::uuid`
    await identity.$executeRaw`
      INSERT INTO aggregator (id, tenant_id, aggregator_code, display_name, status, is_default, updated_at)
      VALUES (gen_random_uuid(), ${tenantUuid}::uuid, '3', 'GSCB', 'ACTIVE', true, now())
    `

    // 1. The gap, stated: identity has the default, TMS has nothing.
    const identityCount = await identity.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM aggregator WHERE is_default`
    expect(Number(identityCount[0]!.n)).toBe(1)
    const before = await tms.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM aggregator_projection`
    expect(Number(before[0]!.n)).toBe(0)

    // 2. Identity announces its own default. No cross-context read: it never
    // asks TMS what is missing, it restates what it holds.
    const res = await announceDefaultAggregators(identity, { traceId: 'trace-rt-announce' })
    expect(res.announced).toHaveLength(1)

    const facts = await identityFacts()
    const aggFacts = facts.filter((f) => f.type === 'fct.identity.aggregator.v1')
    expect(aggFacts).toHaveLength(1)

    // 3. The consumer projects it, and the projection now agrees with identity.
    await projectAggregatorFact(tms, aggFacts[0] as never)
    const projected = await tms.$queryRaw<
      { aggregator_code: string; display_name: string; is_default: boolean; tenant_id: string }[]
    >`SELECT aggregator_code, display_name, is_default, tenant_id::text AS tenant_id FROM aggregator_projection`
    expect(projected).toHaveLength(1)
    expect(projected[0]!.aggregator_code).toBe('3')
    expect(projected[0]!.display_name).toBe('GSCB')
    expect(projected[0]!.is_default).toBe(true)
    expect(projected[0]!.tenant_id).toBe(tenantUuid)
    expect(res.announced[0]!.tnntId).toBe(bank.tnntId)

    // 4. Running it again enqueues nothing, so the repair cannot double-fire.
    const second = await announceDefaultAggregators(identity, { traceId: 'trace-rt-again' })
    expect(second.announced).toHaveLength(0)
    expect(second.alreadyAnnounced).toBe(1)
    const stillOne = await identityFacts()
    expect(stillOne.filter((f) => f.type === 'fct.identity.aggregator.v1')).toHaveLength(1)
  })
})
