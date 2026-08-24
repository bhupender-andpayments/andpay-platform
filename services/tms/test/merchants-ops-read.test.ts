import { describe, it, expect, afterAll } from 'vitest'
import { PrismaClient } from '../generated/client/index.js'
import { listMerchants } from '../src/ops-read.js'
import { newId, toUuid } from '@andpay/ids'

// Redesign step 7 (ruling 1b): the class-3 ops Merchants list.
//
// merchant_projection is a PROJECTION other TMS test files write through
// projectMerchantFact, so this file never truncates it. Every row it creates is
// deleted BY ID in a finally, the same convention damage-reason.test.ts uses for
// the reference master, and every assertion filters to this file's own rows so a
// projection row left by another file cannot make it pass or fail.
const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

afterAll(async () => {
  await db.$disconnect()
})

interface Seeded {
  wire: string
  uuid: string
}

async function seedMerchant(opts: {
  displayName: string
  legalName?: string
  mcc?: string
  status?: string
}): Promise<Seeded> {
  const wire = newId('mrch')
  const uuid = toUuid(wire)
  await db.$executeRaw`
    INSERT INTO merchant_projection (id, display_name, legal_name, mcc, status, updated_at)
    VALUES (
      ${uuid}::uuid, ${opts.displayName}, ${opts.legalName ?? 'LEGAL ' + opts.displayName},
      ${opts.mcc ?? '5411'}, ${opts.status ?? 'ACTIVE'}, now()
    )
  `
  return { wire, uuid }
}

async function removeMerchants(ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.$executeRaw`DELETE FROM merchant_projection WHERE id = ${id}::uuid`
  }
}

// D-2, the TAG, derived at READ TIME (Bhupender's ruling). An "additional
// soundbox request" is a request for a merchant we already had, and the signal
// for it (identity's `mintedMerchant`) is computed at projection time and
// thrown away. Rather than push it onto the enrollment fact, which would be a
// fact-schema change and therefore a corpus decision, it is worked out here
// from what TMS already stores: a merchant with more than one assignment has
// had additional requests.
interface SeedAssignmentOpts {
  origin?: string
  contactName?: string
  email?: string | null
  city?: string | null
  createdAt?: string
}

async function seedAssignment(merchantUuid: string, vpa: string, opts: SeedAssignmentOpts = {}): Promise<string> {
  const asgnUuid = toUuid(newId('asgn'))
  const createdAt = opts.createdAt ?? '2026-01-01T00:00:00.000Z'
  await db.$executeRaw`
    INSERT INTO assignment (
      id, merchant_id, program_id, tenant_id,
      merchant_display_name, merchant_legal_name, merchant_mcc,
      bank_reference_code, bank_display_name, ship_to_address,
      qr_value, vpa_value, soundbox, standee_count, sticker_count,
      billable, demand_state, origin, source_event_id, contact_name, mobile, branch_code,
      email, city, state, pincode, qr_type, dispatch_group, created_at, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${merchantUuid}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
      'Probe', 'Probe Pvt Ltd', '5411',
      '3', 'GSCB', 'Addr',
      ${'upi://pay?pa=' + vpa}, ${vpa}, ${true}, 1, 1,
      ${true}, 'received', ${opts.origin ?? 'bank_file'}, ${'probe|' + vpa},
      ${opts.contactName ?? 'Contact'}, '9000000000', '30',
      ${opts.email ?? null}, ${opts.city ?? null}, 'Gujarat', '380008', null,
      'SOUNDBOX', ${new Date(createdAt)}, now()
    )
  `
  return asgnUuid
}

async function removeAssignments(ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.$executeRaw`DELETE FROM assignment WHERE id = ${id}::uuid`
  }
}

describe('listMerchants: the additional-soundbox tag (D-2, derived at read time)', () => {
  it('marks a merchant with more than one request, and leaves the others alone', async () => {
    const repeat = await seedMerchant({ displayName: 'ZZ REPEAT BUYER' })
    const once = await seedMerchant({ displayName: 'ZZ ONE ORDER' })
    const none = await seedMerchant({ displayName: 'ZZ NO ORDERS' })
    const asgns: string[] = []
    try {
      asgns.push(await seedAssignment(repeat.uuid, 'rep1@gscb'))
      asgns.push(await seedAssignment(repeat.uuid, 'rep2@gscb'))
      asgns.push(await seedAssignment(once.uuid, 'once@gscb'))

      const rows = await listMerchants(db)
      const byId = new Map(rows.map((r) => [r.mrchId, r]))

      // The whole point: a second request for a merchant we already had.
      expect(byId.get(repeat.wire)?.hasAdditionalRequests).toBe(true)
      // One request is the merchant's FIRST, which is not "additional".
      expect(byId.get(once.wire)?.hasAdditionalRequests).toBe(false)
      // No requests at all must not read as "additional" either, which is the
      // way a naive EXISTS on the assignment table gets this wrong.
      expect(byId.get(none.wire)?.hasAdditionalRequests).toBe(false)
    } finally {
      await removeAssignments(asgns)
      await removeMerchants([repeat.uuid, once.uuid, none.uuid])
    }
  })

  // Derived, never stored: nothing was added to a fact, a migration or a
  // projection. Deleting the extra request makes the tag go away by itself.
  it('is a derivation, so removing the second request clears the tag', async () => {
    const m = await seedMerchant({ displayName: 'ZZ DERIVED TAG' })
    const asgns: string[] = []
    try {
      asgns.push(await seedAssignment(m.uuid, 'der1@gscb'))
      const second = await seedAssignment(m.uuid, 'der2@gscb')
      // Tracked for the finally too: source_event_id is UNIQUE, so a row this
      // test leaves behind makes the NEXT run fail on a duplicate key rather
      // than on anything real.
      asgns.push(second)

      const before = (await listMerchants(db)).find((r) => r.mrchId === m.wire)
      expect(before?.hasAdditionalRequests).toBe(true)

      await removeAssignments([second])
      const after = (await listMerchants(db)).find((r) => r.mrchId === m.wire)
      expect(after?.hasAdditionalRequests).toBe(false)
    } finally {
      await removeAssignments(asgns)
      await removeMerchants([m.uuid])
    }
  })
})

describe('listMerchants: the ops Merchants list (redesign step 7)', () => {
  it('reads under tms_ops_read at all, which is what the new GRANT buys', async () => {
    // THE POINT OF THIS ASSERTION. listMerchants does SET LOCAL ROLE
    // tms_ops_read, and before migration 20260808190000 that role had no grant
    // on merchant_projection, so this call raised a Postgres permission-denied
    // rather than returning an empty list. Revoke the grant and this fails.
    await expect(listMerchants(db)).resolves.toBeInstanceOf(Array)
  })

  it('emits the WIRE id, never the raw uuid (D-A)', async () => {
    const m = await seedMerchant({ displayName: 'ZZ WIRE ID PROBE' })
    try {
      const row = (await listMerchants(db)).find((r) => r.mrchId === m.wire)
      expect(row, 'the seeded merchant must be listed').toBeDefined()
      expect(row?.mrchId).toMatch(/^mrch_/)
      expect(JSON.stringify(row)).not.toContain(m.uuid)
    } finally {
      await removeMerchants([m.uuid])
    }
  })

  it('orders by the name a human calls the merchant, not by arrival', async () => {
    // Seeded in the WRONG order on purpose, so passing cannot be an accident of
    // insertion order.
    const c = await seedMerchant({ displayName: 'ZZ ORDER CHARLIE' })
    const a = await seedMerchant({ displayName: 'ZZ ORDER ALPHA' })
    const b = await seedMerchant({ displayName: 'ZZ ORDER BRAVO' })
    try {
      const mine = (await listMerchants(db))
        .filter((r) => r.displayName.startsWith('ZZ ORDER '))
        .map((r) => r.displayName)
      expect(mine).toEqual(['ZZ ORDER ALPHA', 'ZZ ORDER BRAVO', 'ZZ ORDER CHARLIE'])
    } finally {
      await removeMerchants([a.uuid, b.uuid, c.uuid])
    }
  })

  it('returns SUSPENDED merchants too, so a search cannot silently hide one', async () => {
    // A merchant search that omits suspended merchants sends the operator
    // looking for a record that does exist. This is the same failure mode that
    // got option 1c rejected.
    const active = await seedMerchant({ displayName: 'ZZ STATUS ACTIVE', status: 'ACTIVE' })
    const susp = await seedMerchant({ displayName: 'ZZ STATUS SUSPENDED', status: 'SUSPENDED' })
    try {
      const mine = (await listMerchants(db)).filter((r) => r.displayName.startsWith('ZZ STATUS '))
      expect(mine.map((r) => r.status).sort()).toEqual(['ACTIVE', 'SUSPENDED'])
    } finally {
      await removeMerchants([active.uuid, susp.uuid])
    }
  })

  it('carries EXACTLY the ruled field set, so nothing else reaches the wire unnoticed', async () => {
    const m = await seedMerchant({ displayName: 'ZZ SHAPE PROBE', legalName: 'ZZ SHAPE LEGAL', mcc: '5812' })
    try {
      const row = (await listMerchants(db)).find((r) => r.mrchId === m.wire)
      expect(row).toBeDefined()
      // AN EXACT KEY SET, not a subset check. This guard is what forces every
      // widening of this read to be a conscious decision rather than an
      // incidental one, and it has now done that twice.
      //
      // It used to read "and NOTHING else (D104 default-exclude)". On
      // 22 Aug 2026 that posture was reversed for THIS LIST ONLY: the BRD's
      // merchant record is the bank-file field table, so the contact block and
      // the VPA are now disclosed here on purpose
      // (docs/plan/CORPUS_SUBMISSION_2026-08-22_MERCHANTS_LIST.md). The guard
      // stays exact so the next widening is argued too, and so the reversal
      // cannot quietly spread: the pool, batch and dispatch reads keep their
      // own PII-free guards, which this change did not touch.
      expect(Object.keys(row ?? {}).sort()).toEqual([
        'address',
        'bankDisplayName',
        'bankReferenceCode',
        'branchCode',
        'city',
        'contactName',
        'createdAt',
        'displayName',
        'email',
        'hasAdditionalRequests',
        'latestRequestAt',
        'latestRequestOrigin',
        'legalName',
        'mcc',
        'mobile',
        'mrchId',
        'pincode',
        'qrType',
        'state',
        'status',
        'updatedAt',
        'vpa',
      ])
      expect(row?.legalName).toBe('ZZ SHAPE LEGAL')
      expect(row?.mcc).toBe('5812')
    } finally {
      await removeMerchants([m.uuid])
    }
  })
})

// The BRD 5.1b block, 22 Aug 2026. It is snapshotted onto every assignment, so
// the list reaches it through a lateral join to the merchant's most recent one.
describe('listMerchants: the BRD 5.1b block from the latest request', () => {
  it('projects the bank-supplied block from the merchant\'s request', async () => {
    const m = await seedMerchant({ displayName: 'ZZ BRD BLOCK' })
    const asgns: string[] = []
    try {
      asgns.push(
        await seedAssignment(m.uuid, 'brdblock@gscb', {
          email: 'shop@brdblock.example',
          city: 'AHMEDABAD',
        }),
      )
      const row = (await listMerchants(db)).find((r) => r.mrchId === m.wire)
      expect(row?.vpa).toBe('brdblock@gscb')
      expect(row?.contactName).toBe('Contact')
      expect(row?.mobile).toBe('9000000000')
      expect(row?.email).toBe('shop@brdblock.example')
      expect(row?.city).toBe('AHMEDABAD')
      expect(row?.state).toBe('Gujarat')
      expect(row?.pincode).toBe('380008')
      expect(row?.address).toBe('Addr')
      expect(row?.bankDisplayName).toBe('GSCB')
      expect(row?.bankReferenceCode).toBe('3')
      expect(row?.branchCode).toBe('30')
    } finally {
      await removeAssignments(asgns)
      await removeMerchants([m.uuid])
    }
  })

  // THE WHOLE REASON THE JOIN IS A LEFT JOIN. A merchant created by hand has no
  // assignment at all, and an inner join would delete them from the one page
  // whose entire job is that they can be found. Nulls, never an absent row.
  it('keeps a merchant with no request at all, with the block null', async () => {
    const m = await seedMerchant({ displayName: 'ZZ NO REQUEST YET' })
    try {
      const row = (await listMerchants(db)).find((r) => r.mrchId === m.wire)
      expect(row, 'a merchant with no request must still be listed').toBeDefined()
      expect(row?.vpa).toBeNull()
      expect(row?.contactName).toBeNull()
      expect(row?.bankDisplayName).toBeNull()
      expect(row?.latestRequestOrigin).toBeNull()
      expect(row?.latestRequestAt).toBeNull()
      // The merchant's own columns are unaffected by the missing request.
      expect(row?.displayName).toBe('ZZ NO REQUEST YET')
    } finally {
      await removeMerchants([m.uuid])
    }
  })

  // LATEST, not arbitrary: a merchant who moved shop should read as where they
  // are now, so the newest request wins.
  it('takes the most recent request when a merchant has several', async () => {
    const m = await seedMerchant({ displayName: 'ZZ LATEST WINS' })
    const asgns: string[] = []
    try {
      asgns.push(
        await seedAssignment(m.uuid, 'old@gscb', { city: 'OLD CITY', createdAt: '2026-01-01T00:00:00.000Z' }),
      )
      asgns.push(
        await seedAssignment(m.uuid, 'new@gscb', {
          city: 'NEW CITY',
          origin: 'ADDITIONAL',
          createdAt: '2026-06-01T00:00:00.000Z',
        }),
      )
      const row = (await listMerchants(db)).find((r) => r.mrchId === m.wire)
      expect(row?.city).toBe('NEW CITY')
      expect(row?.vpa).toBe('new@gscb')
      expect(row?.latestRequestOrigin).toBe('ADDITIONAL')
    } finally {
      await removeAssignments(asgns)
      await removeMerchants([m.uuid])
    }
  })

  // The lateral takes ONE row. If it ever stopped doing that, a merchant with
  // two requests would appear twice and the page would show a duplicate.
  it('returns one row per merchant however many requests they have', async () => {
    const m = await seedMerchant({ displayName: 'ZZ NO DUPLICATES' })
    const asgns: string[] = []
    try {
      asgns.push(await seedAssignment(m.uuid, 'dup1@gscb'))
      asgns.push(await seedAssignment(m.uuid, 'dup2@gscb'))
      asgns.push(await seedAssignment(m.uuid, 'dup3@gscb'))
      const mine = (await listMerchants(db)).filter((r) => r.mrchId === m.wire)
      expect(mine).toHaveLength(1)
    } finally {
      await removeAssignments(asgns)
      await removeMerchants([m.uuid])
    }
  })
})
