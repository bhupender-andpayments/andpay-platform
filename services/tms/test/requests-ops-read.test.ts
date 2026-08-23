import { describe, it, expect, afterAll } from 'vitest'
import { PrismaClient } from '../generated/client/index.js'
import { listRequestLegsOps } from '../src/ops-read.js'
import { newId, toUuid } from '@andpay/ids'

// 23 Aug 2026: the Requests page detail view widening. listRequestLegsOps
// already read every field the LIST needed; this only adds the BRD 5.1b
// contact/address/QR-type columns the new request DETAIL page shows, the same
// columns the Merchants list widening already surfaces (services/tms/test/
// merchants-ops-read.test.ts), just not previously selected by THIS query.
const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

afterAll(async () => {
  await db.$disconnect()
})

interface SeedOpts {
  sourceEventId: string
  contactName?: string | null
  mobile?: string | null
  email?: string | null
  shipToAddress?: string
  city?: string | null
  state?: string | null
  pincode?: string | null
  qrType?: string | null
}

async function seedAssignment(opts: SeedOpts): Promise<string> {
  const asgnUuid = toUuid(newId('asgn'))
  await db.$executeRaw`
    INSERT INTO assignment (
      id, merchant_id, program_id, tenant_id,
      merchant_display_name, merchant_legal_name, merchant_mcc,
      bank_reference_code, bank_display_name, ship_to_address,
      qr_value, vpa_value, soundbox, standee_count, sticker_count,
      billable, demand_state, origin, source_event_id, contact_name, mobile,
      branch_code, email, city, state, pincode, qr_type, dispatch_group,
      created_at, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
      'ZZ REQUEST DETAIL PROBE', 'ZZ REQUEST DETAIL PROBE PVT LTD', '5411',
      '3', 'GSCB', ${opts.shipToAddress ?? 'Addr'},
      'upi://pay?pa=reqprobe@gscb', 'reqprobe@gscb', ${true}, 1, 1,
      ${true}, 'received', 'bank_file', ${opts.sourceEventId},
      ${opts.contactName ?? null}, ${opts.mobile ?? null}, '30',
      ${opts.email ?? null}, ${opts.city ?? null}, ${opts.state ?? null}, ${opts.pincode ?? null}, ${opts.qrType ?? null},
      'SOUNDBOX', now(), now()
    )
  `
  return asgnUuid
}

async function removeAssignment(id: string): Promise<void> {
  await db.$executeRaw`DELETE FROM assignment WHERE id = ${id}::uuid`
}

describe('listRequestLegsOps: the BRD 5.1b contact and address block', () => {
  it('reads contact, mobile, email, address, city, state, pincode and QR type', async () => {
    const sourceEventId = `zz-req-probe-${newId('asgn')}`
    const asgnUuid = await seedAssignment({
      sourceEventId,
      contactName: 'Ravi Shankar',
      mobile: '9168493103',
      email: 'shop@reqprobe.example',
      shipToAddress: 'PLOT 7 STATION ROAD, MANI NAGAR',
      city: 'AHMEDABAD',
      state: 'Gujarat',
      pincode: '380001',
      qrType: 'STATIC',
    })
    try {
      const legs = await listRequestLegsOps(db)
      const leg = legs.find((l) => l.sourceEventId === sourceEventId)
      expect(leg, 'the seeded leg must be listed').toBeDefined()
      expect(leg?.contactName).toBe('Ravi Shankar')
      expect(leg?.mobile).toBe('9168493103')
      expect(leg?.email).toBe('shop@reqprobe.example')
      expect(leg?.shipToAddress).toBe('PLOT 7 STATION ROAD, MANI NAGAR')
      expect(leg?.city).toBe('AHMEDABAD')
      expect(leg?.state).toBe('Gujarat')
      expect(leg?.pincode).toBe('380001')
      expect(leg?.qrType).toBe('STATIC')
    } finally {
      await removeAssignment(asgnUuid)
    }
  })

  // Additive, nullable columns (BRD 5.1b): a row that never carried them must
  // read as null rather than fail to project at all.
  it('reads null when the block was never recorded', async () => {
    const sourceEventId = `zz-req-null-${newId('asgn')}`
    const asgnUuid = await seedAssignment({ sourceEventId })
    try {
      const legs = await listRequestLegsOps(db)
      const leg = legs.find((l) => l.sourceEventId === sourceEventId)
      expect(leg, 'the seeded leg must be listed').toBeDefined()
      expect(leg?.contactName).toBeNull()
      expect(leg?.mobile).toBeNull()
      expect(leg?.email).toBeNull()
      expect(leg?.city).toBeNull()
      expect(leg?.state).toBeNull()
      expect(leg?.pincode).toBeNull()
      expect(leg?.qrType).toBeNull()
    } finally {
      await removeAssignment(asgnUuid)
    }
  })
})
