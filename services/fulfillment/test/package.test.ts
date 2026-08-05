import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { buildDispatchPackage } from '../src/package.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE pending_pool_entry, composed_artifact, bank_composition_config, batch, batch_pool, saga_timer, saga_step, saga_instance, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

// LOCAL fixture (mirrors dispatch.test.ts seedBankConfig): there is no
// production seed helper for bank_composition_config.
async function seedBankConfig(tenantUuid: string, bankCode: string): Promise<string> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO bank_composition_config (
      id, tenant_id, bank_code, logo_master_ref, logo_derivative_ref, branding_params, image_templates, updated_at
    ) VALUES (
      gen_random_uuid(), ${tenantUuid}::uuid, ${bankCode}, 'ref-logo-master', 'ref-logo-derivative',
      '{}'::jsonb, '{"SOUNDBOX":{},"STANDEE":{}}'::jsonb, now()
    )
    RETURNING id::text AS id
  `
  return rows[0]!.id
}

interface SeededEntry {
  asgnWire: string
  asgnUuid: string
  shipToAddress: string
  contactName: string
  mobile: string
  merchantDisplayName: string
  qrValue: string
}

// A fixture pending_pool_entry row, ALREADY BATCHED (mirrors dispatch.test.ts
// seedBatchedEntry), extended per the Task 7 brief with ship_to_contact_name
// and ship_to_mobile (fold correction: the dispatch.test.ts fixture predates
// those two columns landing).
async function seedBatchedEntry(
  tenantUuid: string,
  programUuid: string,
  btchUuid: string,
  bankCode: string,
): Promise<SeededEntry> {
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  const merchantUuid = toUuid(newId('mrch'))
  const shipToAddress = '221B Baker Street'
  const contactName = 'Priya Sharma'
  const mobile = '+919812345678'
  const merchantDisplayName = 'Acme'
  const qrValue = 'upi://pay?pa=acme@hdfcbank'
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, ship_to_contact_name, ship_to_mobile, qr_value, vpa_value, pool_status, batch,
      source_event_id, trace_id, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${merchantUuid}::uuid, true, 1, 0, true,
      ${merchantDisplayName}, 'Acme Pvt Ltd', '5814', ${bankCode}, 'HDFC Bank',
      ${shipToAddress}, ${contactName}, ${mobile}, ${qrValue}, 'acme@hdfcbank', 'BATCHED', ${btchUuid}::uuid,
      'file-1|1', 'trace-pkg', now()
    )
  `
  return { asgnWire, asgnUuid, shipToAddress, contactName, mobile, merchantDisplayName, qrValue }
}

async function seedComposedArtifact(
  tenantUuid: string,
  programUuid: string,
  btchUuid: string,
  asgnUuid: string,
  artifactType: string,
  assetReference: string,
  labelDisplayName: string,
  labelQr: string,
  bankConfigId: string,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO composed_artifact (
      id, asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference, label_display_name, label_qr, bank_config_ref
    ) VALUES (
      gen_random_uuid(), ${asgnUuid}::uuid, ${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid,
      ${artifactType}, ${assetReference}, ${labelDisplayName}, ${labelQr}, ${bankConfigId}::uuid
    )
  `
}

describe('buildDispatchPackage (per-adapter dispatch package projection, D104 check 2)', () => {
  it('print view carries QR label collateral only, NO shipping-recipient PII', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)

    const bankConfigId = await seedBankConfig(tenantUuid, 'HDFC')
    const entry = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'HDFC')
    await seedComposedArtifact(
      tenantUuid, programUuid, btchUuid, entry.asgnUuid, 'SOUNDBOX_IMG', 'ref-soundbox',
      entry.merchantDisplayName, entry.qrValue, bankConfigId,
    )
    await seedComposedArtifact(
      tenantUuid, programUuid, btchUuid, entry.asgnUuid, 'STANDEE_IMG', 'ref-standee',
      entry.merchantDisplayName, entry.qrValue, bankConfigId,
    )

    const printLines = await buildDispatchPackage(db, btchWire, 'print')
    expect(printLines).toHaveLength(1)
    const line = printLines[0]!
    expect(line.asgnId).toBe(entry.asgnWire)
    expect(new Set(line.artifacts.map((a) => a.assetReference))).toEqual(new Set(['ref-soundbox', 'ref-standee']))
    expect(line.labelDisplayName).toBe(entry.merchantDisplayName)
    expect(line.labelQr).toBe(entry.qrValue)

    // provably NO shipping-recipient PII keys on the print view (structural,
    // not merely "happens to be falsy").
    expect(Object.keys(line)).not.toContain('shipToAddress')
    expect(Object.keys(line)).not.toContain('contactName')
    expect(Object.keys(line)).not.toContain('mobile')

    // belt-and-suspenders: the seeded shipping values are nowhere in the
    // serialized print view at all.
    const serialized = JSON.stringify(printLines)
    expect(serialized).not.toContain(entry.shipToAddress)
    expect(serialized).not.toContain(entry.contactName)
    expect(serialized).not.toContain(entry.mobile)
  })

  it('ship view carries the print view PLUS the shipping recipient block from the snapshot', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)

    const bankConfigId = await seedBankConfig(tenantUuid, 'HDFC')
    const entry = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'HDFC')
    await seedComposedArtifact(
      tenantUuid, programUuid, btchUuid, entry.asgnUuid, 'SOUNDBOX_IMG', 'ref-soundbox',
      entry.merchantDisplayName, entry.qrValue, bankConfigId,
    )

    const shipLines = await buildDispatchPackage(db, btchWire, 'ship')
    expect(shipLines).toHaveLength(1)
    const line = shipLines[0]!

    // print-view fields still present (ship is print-plus, not a replacement).
    expect(line.asgnId).toBe(entry.asgnWire)
    expect(line.artifacts.map((a) => a.assetReference)).toEqual(['ref-soundbox'])
    expect(line.artifacts[0]!.artifactType).toBe('SOUNDBOX_IMG')
    expect(line.labelDisplayName).toBe(entry.merchantDisplayName)
    expect(line.labelQr).toBe(entry.qrValue)

    // the shipping recipient block, equal to the seeded snapshot values.
    expect(line.shipToAddress).toBe(entry.shipToAddress)
    expect(line.contactName).toBe(entry.contactName)
    expect(line.mobile).toBe(entry.mobile)
  })

  it('is a read-only projection: nothing persisted, and no dispatch-package table exists', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)

    const bankConfigId = await seedBankConfig(tenantUuid, 'HDFC')
    const entry = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'HDFC')
    await seedComposedArtifact(
      tenantUuid, programUuid, btchUuid, entry.asgnUuid, 'SOUNDBOX_IMG', 'ref-soundbox',
      entry.merchantDisplayName, entry.qrValue, bankConfigId,
    )

    const before = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM composed_artifact`

    await buildDispatchPackage(db, btchWire, 'print')
    await buildDispatchPackage(db, btchWire, 'ship')

    const after = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM composed_artifact`
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n))

    // structural: in the WHOLE fulfillment schema, only pending_pool_entry
    // carries the shipping-PII columns. There is no separate dispatch-package
    // table at all (D104: the package is generated at hand-off, not stored).
    const cols = await db.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'fulfillment'
        AND column_name IN ('ship_to_address', 'ship_to_contact_name', 'ship_to_mobile')
    `
    const tablesCarryingShipPII = new Set(cols.map((c) => c.table_name))
    expect(tablesCarryingShipPII).toEqual(new Set(['pending_pool_entry']))

    // the retained composed_artifact rows exist, and structurally carry no
    // shipping-PII column (mirrors the dispatch.test.ts structural assertion).
    const artifactCols = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'fulfillment' AND table_name = 'composed_artifact'
    `
    const artifactColNames = new Set(artifactCols.map((c) => c.column_name))
    expect(artifactColNames.has('ship_to_address')).toBe(false)
    expect(artifactColNames.has('ship_to_contact_name')).toBe(false)
    expect(artifactColNames.has('ship_to_mobile')).toBe(false)

    const artifactRows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid
    `
    expect(Number(artifactRows[0]!.n)).toBe(1)
  })
})
