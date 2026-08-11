import { describe, it, expect, expectTypeOf, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { authorize, type LeanClaim } from '@andpay/authz'
import {
  PrismaClient as AuthClient,
  issueVendorCredential,
  resolveVendorCredential,
  LocalPepperAdapter,
} from '@andpay/auth-service'
import {
  PrismaClient as FulfillmentClient,
  createVendor,
  ingestIntakeSheet,
  ingestReturnSheet,
  ingestStatusFile,
  projectDemandFact,
  onDemandAccrued,
  triggerBatch,
  loadFulfillmentConfig,
  poolConfig,
  UNIT_TOPIC,
  BATCH_TOPIC,
  PRINT_FOR_TOPIC,
  type FulfillmentDb,
  type IntakeSheet,
  type ReturnSheet,
  type AssignmentFactView,
  type UnitFactPayload,
  type BatchFactPayload,
  type PrintForFactPayload,
  type ShipmentFactPayload,
} from '@andpay/fulfillment-service'

// Root-only integration seam (this file is under test/, not services/<ctx>, so
// the cross-schema guard, test/architecture.test.ts, never scans it). This is
// the ONE place in the repo allowed to import both @andpay/auth-service and
// @andpay/fulfillment-service: it is the runtime proof that the REAL class-6
// vendor credential (issued and resolved by Auth) binds to fulfillment's own
// vndr_/intake path with no drift (check 6), and that fulfillment's own
// functions never receive Auth's db handle (check 5, no C4 read). Each service
// gets its OWN Prisma client, pinned to its OWN schema, exactly mirroring
// test/tms_identity_roundtrip.test.ts's precedent.
const authUrl =
  process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const authDb = new AuthClient({ datasourceUrl: authUrl })
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })

// The 5c pepper: the SAME underlying key is used to build the issue-side
// PepperPort (an HMAC adapter) and the resolve-side raw pepper, so the
// peppered-hash lookup matches (mirrors services/auth/test/vendor-credential.test.ts
// exactly: LocalPepperAdapter(pepper) for issue, the raw `pepper` string for
// resolve).
const pepper = 'dev-pepper-not-a-real-secret'
const pepperPort = new LocalPepperAdapter(pepper)

// A class-3 ops actor whose claim satisfies the vendor_credential:create
// step-up (STEP_UP_CATALOG requires AAL2, fresh within 300s of auth_time):
// mirrors services/auth/test/vendor-credential.test.ts's own opsClaim fixture
// verbatim (same field shape, same acr/amr/auth_time pattern).
const operatorId = randomUUID()
function opsActorClaim(authTime: number): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: operatorId,
    aud: 'andpay:internal-admin',
    iat: authTime,
    exp: authTime + 600,
    nbf: authTime,
    jti: 'jti-root-ops-1',
    cls: 3,
    mode: 'test',
    scope: {},
    psr: 'role:ops',
    epoch: 1,
    acr: 'AAL2',
    amr: ['pwd', 'otp'],
    auth_time: authTime,
  }
}
const opsActor = { operatorId, claim: opsActorClaim(1000) }

beforeEach(async () => {
  await authDb.$executeRawUnsafe('TRUNCATE vendor_credential, denylist, authz_audit, outbox, inbox')
  await fulfillmentDb.$executeRawUnsafe(
    'TRUNCATE vndr, unit, intake_exception, pending_pool_entry, shpt, composed_artifact, batch, batch_pool, saga_timer, saga_step, saga_instance, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await authDb.$disconnect()
  await fulfillmentDb.$disconnect()
})

function deviceQrFixture(serial: string): object {
  return { di: `DI-${serial}`, imei: `IMEI-${serial}`, dom: '2026-01-01', cu: 'CU-1' }
}

interface UnitOutboxRow {
  event_type: string
  partition_key: string
  payload: Envelope<UnitFactPayload>
}
interface BatchOutboxRow {
  event_type: string
  partition_key: string
  payload: Envelope<BatchFactPayload>
}
interface PrintForOutboxRow {
  event_type: string
  partition_key: string
  payload: Envelope<PrintForFactPayload>
}

// A fixture in-inventory unit (as if manufacturer intake, check 6 above,
// already created it): SERIALIZED, IN_STOCK, no batch/shipment/
// printed_for_merchant yet. Clones services/fulfillment/test/return-sheet.test.ts's
// seedUnit exactly (a raw insert, on fulfillmentDb only): check 3's return-edge
// proof is about the REAL class-6 credential driving ingestReturnSheet, not
// about the unit's own manufacturer-intake lineage (already proven end to end
// above).
async function seedReturnUnit(deviceSerial: string): Promise<void> {
  const unitUuid = toUuid(newId('unit'))
  const manufacturerVndrUuid = toUuid(newId('vndr'))
  await fulfillmentDb.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, updated_at)
    VALUES (${unitUuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${manufacturerVndrUuid}::uuid, 'IN_STOCK', ${deviceSerial}, '{}'::jsonb, now())
  `
}

interface SeedReturnEntryOpts {
  asgnUuid: string
  tenantUuid: string
  programUuid: string
  merchantUuid: string
  batchUuid: string
  traceId: string
}

// A fixture pending_pool_entry, already SENT_TO_VENDOR (as if the dispatch PM
// already ran compose+dispatch): the event-carried snapshot ingestReturnSheet
// reads, with no C4 read of merchant/ship-to. Clones
// services/fulfillment/test/return-sheet.test.ts's seedPendingEntry exactly,
// carrying every NOT NULL snapshot column.
async function seedReturnPendingEntry(opts: SeedReturnEntryOpts): Promise<void> {
  await fulfillmentDb.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, dispatch_state, source_event_id, trace_id,
      created_at, updated_at
    ) VALUES (
      ${opts.asgnUuid}::uuid, ${opts.tenantUuid}::uuid, ${opts.programUuid}::uuid, ${opts.merchantUuid}::uuid,
      true, 1, 0, true, 'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'BATCHED', ${opts.batchUuid}::uuid, 'SENT_TO_VENDOR',
      'file-root-return|1', ${opts.traceId}, now(), now()
    )
  `
}

describe('root class-6 binding round trip: createVendor -> issueVendorCredential -> resolveVendorCredential -> ingestIntakeSheet (check 6)', () => {
  it('the REAL resolved class-6 claim (not a fixture) authorizes its own-vendor intake sheet and creates Units; the intake unit fact carries the file traceId', async () => {
    // 1. Fulfillment creates its own vndr_ (class-3 ops action, S13). Fulfillment
    // owns the vndr_ business entity; Auth owns the class-6 credential that
    // binds to it (D115/D121). No cross-context call: two separate writes to two
    // separate db handles, joined only by the wire vndr_ id.
    const { vndrId } = await createVendor(
      fulfillmentDb,
      { type: 'MANUFACTURER', displayName: 'Acme Devices' },
      { operatorId },
      'trace-root-create-vendor',
    )
    expect(vndrId.startsWith('vndr_')).toBe(true)

    const workQueue = 'wq-root-manufacturer'

    // 2. Auth issues the class-6 vendor credential, bound to vndrId/workQueue,
    // permissionSetRef 'vset:vendor_manufacturer' (auth's own local vendor-set
    // declaration, config/vendor-sets.ts; C4: never imported from fulfillment).
    // requireStepUp needs the actor's claim to carry a fresh AAL2 proof, which
    // opsActor above supplies.
    const issued = await issueVendorCredential(
      { vndrId, workQueue, permissionSetRef: 'vset:vendor_manufacturer', mode: 'test', idempotencyKey: 'root-issue-v1' },
      opsActor,
      { db: authDb, pepper: pepperPort, traceId: 'trace-root-issue', now: 1000 },
    )
    expect(issued.reused).toBe(false)
    expect(issued.secret.startsWith('apsk_test_')).toBe(true)
    expect(issued.apiId.startsWith('api_')).toBe(true)

    // 3. Auth resolves the show-once secret to the uniform class-6 LeanClaim,
    // using the SAME underlying pepper (the raw string this time, not the
    // PepperPort) so the peppered-hash lookup matches.
    const claim = await resolveVendorCredential(issued.secret, {
      db: authDb,
      pepper,
      expectedMode: 'test',
      now: 1000,
    })
    expect(claim.cls).toBe(6)
    expect(claim.sub).toBe(issued.apiId)
    expect(claim.scope.vndr).toBe(vndrId)
    expect(claim.scope.wq).toBe(workQueue)
    expect(claim.psr).toBe('vset:vendor_manufacturer')

    // 4. Feed the REAL resolved claim (not a fixture, unlike
    // services/fulfillment/test/intake.test.ts's classSixClaim helper) to
    // ingestIntakeSheet. This is the FIRST real use of the class-6 credential
    // end to end (spec 04 exercised issue/resolve only; Task 7 used a fixture
    // claim). Fulfillment's ingestIntakeSheet takes ONLY fulfillmentDb: no auth
    // db handle crosses this boundary (check 5).
    const sheet: IntakeSheet = {
      fileId: 'file-root-1',
      vndrId,
      workQueue,
      rows: [{ kind: 'SERIALIZED', deviceSerial: 'SER-ROOT-1', productType: 'SOUNDBOX', deviceQr: deviceQrFixture('SER-ROOT-1') }],
    }
    const res = await ingestIntakeSheet(fulfillmentDb, claim, sheet, 'trace-root-intake')
    expect(res.rejected).toBeUndefined()
    expect(res.deduped).toBe(false)
    expect(res.createdUnitIds).toHaveLength(1)

    const units = await fulfillmentDb.$queryRaw<{ device_serial: string; manufacturer_vndr: string; status: string }[]>`
      SELECT device_serial, manufacturer_vndr, status FROM unit
    `
    expect(units).toHaveLength(1)
    expect(units[0]!.device_serial).toBe('SER-ROOT-1')
    expect(units[0]!.manufacturer_vndr).toBe(toUuid(vndrId))
    expect(units[0]!.status).toBe('IN_STOCK')

    // check 8 (a free extra, alongside services/fulfillment/test/intake.test.ts's
    // own fixture-claim version of this assertion): the intake file's traceId
    // lands on the emitted unit fact, end to end through the REAL credential.
    const ob = await fulfillmentDb.$queryRaw<UnitOutboxRow[]>`
      SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${UNIT_TOPIC}
    `
    expect(ob).toHaveLength(1)
    expect(ob[0]!.payload.traceId).toBe('trace-root-intake')
    expect(ob[0]!.payload.payload.unitId).toBe(res.createdUnitIds[0])
  })

  it('105c cross-vendor rejection: a DIFFERENT vendor\'s real resolved claim cannot submit a sheet scoped to vndrId V1 -- ZERO units for that attempt', async () => {
    const { vndrId: v1 } = await createVendor(
      fulfillmentDb,
      { type: 'MANUFACTURER', displayName: 'Acme Devices' },
      { operatorId },
      'trace-root-create-v1',
    )
    const { vndrId: v2 } = await createVendor(
      fulfillmentDb,
      { type: 'MANUFACTURER', displayName: 'Other Devices' },
      { operatorId },
      'trace-root-create-v2',
    )
    const workQueue = 'wq-root-cross'

    const issuedV1 = await issueVendorCredential(
      { vndrId: v1, workQueue, permissionSetRef: 'vset:vendor_manufacturer', mode: 'test', idempotencyKey: 'root-issue-cross-v1' },
      opsActor,
      { db: authDb, pepper: pepperPort, traceId: 'trace-root-issue-v1', now: 1000 },
    )
    const issuedV2 = await issueVendorCredential(
      { vndrId: v2, workQueue, permissionSetRef: 'vset:vendor_manufacturer', mode: 'test', idempotencyKey: 'root-issue-cross-v2' },
      opsActor,
      { db: authDb, pepper: pepperPort, traceId: 'trace-root-issue-v2', now: 1000 },
    )

    // seed a legitimate V1 unit first, so we can prove the cross-vendor attempt
    // below adds NOTHING (not merely that the total is small).
    const claimV1 = await resolveVendorCredential(issuedV1.secret, { db: authDb, pepper, expectedMode: 'test', now: 1000 })
    const legitSheet: IntakeSheet = {
      fileId: 'file-root-v1-legit',
      vndrId: v1,
      workQueue,
      rows: [{ kind: 'SERIALIZED', deviceSerial: 'SER-ROOT-V1-LEGIT', productType: 'SOUNDBOX', deviceQr: deviceQrFixture('SER-ROOT-V1-LEGIT') }],
    }
    const legitRes = await ingestIntakeSheet(fulfillmentDb, claimV1, legitSheet, 'trace-root-legit')
    expect(legitRes.rejected).toBeUndefined()
    expect(legitRes.createdUnitIds).toHaveLength(1)

    // V2's OWN real resolved claim (scope.vndr = v2) is fed a sheet claiming to
    // be FOR v1: the class-6 own-vendor-only gate (105c) must deny on
    // scope-mismatch, exactly as services/fulfillment/test/intake.test.ts's
    // fixture-claim version (b) proves, but here with a REAL Auth-resolved
    // claim on both sides of the mismatch.
    const claimV2 = await resolveVendorCredential(issuedV2.secret, { db: authDb, pepper, expectedMode: 'test', now: 1000 })
    expect(claimV2.scope.vndr).toBe(v2)

    const crossSheet: IntakeSheet = {
      fileId: 'file-root-cross',
      vndrId: v1, // the sheet claims to be FOR v1, but claimV2.scope.vndr is v2
      workQueue,
      rows: [{ kind: 'SERIALIZED', deviceSerial: 'SER-ROOT-CROSS', productType: 'SOUNDBOX', deviceQr: deviceQrFixture('SER-ROOT-CROSS') }],
    }
    const crossRes = await ingestIntakeSheet(fulfillmentDb, claimV2, crossSheet, 'trace-root-cross')
    expect(crossRes.rejected).toBe('unauthorized')
    expect(crossRes.createdUnitIds).toHaveLength(0)
    expect(crossRes.deduped).toBe(false)

    // exactly the one legitimate V1 unit exists; the cross-vendor attempt added
    // NOTHING (not even a quarantine or inbox row: authorize denies before any
    // transaction opens, STEP A of ingestIntakeSheet).
    const unitCount = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCount[0]!.n)).toBe(1)
    const exceptionCount = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM intake_exception`
    expect(Number(exceptionCount[0]!.n)).toBe(0)
  })

  it('105d permission universe: the resolved class-6 claim grants ONLY the two manufacturer permissions and structurally cannot reach money/KYC/posture/api_keys:manage/activation', async () => {
    const { vndrId } = await createVendor(
      fulfillmentDb,
      { type: 'MANUFACTURER', displayName: 'Acme Devices' },
      { operatorId },
      'trace-root-create-perm',
    )
    const workQueue = 'wq-root-perm'
    const issued = await issueVendorCredential(
      { vndrId, workQueue, permissionSetRef: 'vset:vendor_manufacturer', mode: 'test', idempotencyKey: 'root-issue-perm' },
      opsActor,
      { db: authDb, pepper: pepperPort, traceId: 'trace-root-issue-perm', now: 1000 },
    )
    const claim = await resolveVendorCredential(issued.secret, { db: authDb, pepper, expectedMode: 'test', now: 1000 })
    expect(claim.psr).toBe('vset:vendor_manufacturer')

    // the vset itself (fulfillment's own local declaration, config-as-code,
    // authz-config.ts) carries EXACTLY the two manufacturer permissions, no more.
    const cfg = loadFulfillmentConfig()
    const perms = cfg.vendorSets['vendor_manufacturer']!.permissions
    expect([...perms].sort()).toEqual(['batch:pull-artifacts', 'sheet:submit-intake'])

    // positive: the two granted permissions authorize on this claim's own vndr/wq.
    expect(authorize(claim, 'sheet:submit-intake', { vndrId, workQueue }, cfg).allowed).toBe(true)
    expect(authorize(claim, 'batch:pull-artifacts', { vndrId, workQueue }, cfg).allowed).toBe(true)

    // negative: every operation outside the class-6 universe (packages/authz's
    // evaluate.ts CLASS_SIX_UNIVERSE comment: "Money and M4 ... KYC attestation
    // ... posture/elevation controls, api_keys:manage, and any activation
    // authority (TMS) are STRUCTURALLY outside this universe") is denied on
    // 'permission-denied', not merely absent from a role list.
    // These five strings are ILLUSTRATIVE non-class-6 operation names, not an
    // enumeration of the whole excluded set. The AUTHORITATIVE structural
    // exclusion, that a vendor set can only ever hold ClassSixPermission
    // values, is enforced by validateVendorSet (packages/authz/src/evaluate.ts)
    // and covered directly by packages/authz/test/evaluate.test.ts and
    // services/auth/test/config.test.ts, so a future edit to the class-6
    // universe should be reflected there first.
    for (const forbidden of ['api_keys:manage', 'assignment:activate', 'kyc:attest', 'posture:elevate', 'ledger:post']) {
      const decision = authorize(claim, forbidden, { vndrId, workQueue }, cfg)
      expect(decision.allowed, `${forbidden} must be denied`).toBe(false)
      expect(decision.reason, `${forbidden} must be denied on permission-denied`).toBe('permission-denied')
    }
  })
})

describe('root class-6 binding round trip: createVendor -> issueVendorCredential -> resolveVendorCredential -> ingestReturnSheet (check 3, S14)', () => {
  it('the REAL resolved class-6 print-vendor claim (not a fixture) authorizes its own-vendor return sheet, pairs the Unit to its asgn, and births the Shipment; ingestReturnSheet receives ONLY the fulfillment db handle', async () => {
    // 1. Fulfillment creates its own vndr_ (class-3 ops action, S13), type
    // PRINT this time: the print/ship vendor RETURN edge, not the
    // MANUFACTURER intake edge proven above (check 6).
    const { vndrId } = await createVendor(
      fulfillmentDb,
      { type: 'PRINT', displayName: 'Acme Print Co' },
      { operatorId },
      'trace-root-create-print-vendor',
    )
    expect(vndrId.startsWith('vndr_')).toBe(true)

    const workQueue = 'wq-root-print'

    // 2. Auth issues the class-6 vendor credential, bound to vndrId/workQueue,
    // permissionSetRef 'vset:vendor_print' (auth's own local vendor-set
    // declaration, services/auth/src/config/vendor-sets.ts; fulfillment's OWN
    // local vendor-set, authz-config.ts, maps vendor_print to EXACTLY
    // 'batch:pull-artifacts' and 'sheet:submit-return', which the sheet ingest
    // below authorizes against).
    const issued = await issueVendorCredential(
      { vndrId, workQueue, permissionSetRef: 'vset:vendor_print', mode: 'test', idempotencyKey: 'root-issue-return-v1' },
      opsActor,
      { db: authDb, pepper: pepperPort, traceId: 'trace-root-issue-return', now: 1000 },
    )
    expect(issued.reused).toBe(false)
    expect(issued.secret.startsWith('apsk_test_')).toBe(true)
    expect(issued.apiId.startsWith('api_')).toBe(true)

    // 3. Auth resolves the show-once secret to the uniform class-6 LeanClaim,
    // using the SAME underlying pepper (the raw string this time, not the
    // PepperPort) so the peppered-hash lookup matches.
    const claim = await resolveVendorCredential(issued.secret, {
      db: authDb,
      pepper,
      expectedMode: 'test',
      now: 1000,
    })
    expect(claim.cls).toBe(6)
    expect(claim.sub).toBe(issued.apiId)
    expect(claim.scope.vndr).toBe(vndrId)
    expect(claim.scope.wq).toBe(workQueue)
    expect(claim.psr).toBe('vset:vendor_print')

    // 4. Seed the in-inventory unit and the SENT_TO_VENDOR pending_pool_entry
    // (the event-carried asgn snapshot ingestReturnSheet reads, with no C4
    // read of merchant/ship-to), cloning
    // services/fulfillment/test/return-sheet.test.ts's own seed shape.
    const deviceSerial = 'SER-ROOT-RETURN-1'
    await seedReturnUnit(deviceSerial)
    const asgnWire = newId('asgn')
    const asgnUuid = toUuid(asgnWire)
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const merchantUuid = toUuid(newId('mrch'))
    const batchUuid = toUuid(newId('btch'))
    const snapshotTraceId = 'trace-root-return-snapshot'
    await seedReturnPendingEntry({ asgnUuid, tenantUuid, programUuid, merchantUuid, batchUuid, traceId: snapshotTraceId })

    // 5. Feed the REAL resolved claim (not a fixture, unlike
    // services/fulfillment/test/return-sheet.test.ts's classSixClaim helper)
    // to ingestReturnSheet. This mirrors check 6's intake round trip above,
    // for the return edge. ingestReturnSheet's own signature takes ONLY
    // fulfillmentDb: no auth db handle crosses this boundary (check 5, S14);
    // this call site never mentions authDb.
    const sheet: ReturnSheet = {
      fileId: 'file-root-return-1',
      vndrId,
      workQueue,
      rows: [{ deviceSerial, asgnId: asgnWire, awb: 'AWB-ROOT-1' }],
    }
    const res = await ingestReturnSheet(fulfillmentDb, claim, sheet, 'trace-root-return-ingest')
    expect(res.rejected).toBeUndefined()
    expect(res.deduped).toBe(false)
    expect(res.pairedUnitIds).toHaveLength(1)
    expect(res.quarantined).toBe(0)
    expect(res.shptIds).toHaveLength(1)
    const shptWire = res.shptIds[0]!

    // check 3 pairing: unit.batch/printed_for_merchant/shipment all written,
    // end to end through the REAL credential.
    const units = await fulfillmentDb.$queryRaw<
      { batch: string | null; printed_for_merchant: string | null; shipment: string | null }[]
    >`SELECT batch::text AS batch, printed_for_merchant::text AS printed_for_merchant, shipment::text AS shipment FROM unit WHERE device_serial = ${deviceSerial}`
    expect(units).toHaveLength(1)
    expect(units[0]!.batch).toBe(batchUuid)
    expect(units[0]!.printed_for_merchant).toBe(merchantUuid)
    expect(units[0]!.shipment).toBe(toUuid(shptWire))

    // one fct.fulfillment.unit.print_for.v1 fact in the fulfillment outbox,
    // carrying the asgn snapshot's OWN trace_id (fold correction 3), not the
    // ingest call's traceId.
    const pf = await fulfillmentDb.$queryRaw<PrintForOutboxRow[]>`
      SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${PRINT_FOR_TOPIC}
    `
    expect(pf).toHaveLength(1)
    expect(pf[0]!.payload.payload.unitId).toBe(res.pairedUnitIds[0])
    expect(pf[0]!.payload.payload.asgnId).toBe(asgnWire)
    expect(pf[0]!.payload.payload.deviceId).toBe(deviceSerial)
    expect(pf[0]!.payload.payload.shptId).toBe(shptWire)
    expect(pf[0]!.payload.traceId).toBe(snapshotTraceId)

    // one shpt row, born DISPATCHED_BY_VENDOR on this AWB.
    const shptRows = await fulfillmentDb.$queryRaw<{ status: string; awb: string }[]>`
      SELECT status, awb FROM shpt WHERE id = ${toUuid(shptWire)}::uuid
    `
    expect(shptRows).toHaveLength(1)
    expect(shptRows[0]!.status).toBe('DISPATCHED_BY_VENDOR')
    expect(shptRows[0]!.awb).toBe('AWB-ROOT-1')
  })

  it("105c cross-vendor rejection with REAL claims: print-vendor V2's own real resolved claim cannot submit a return sheet scoped to vndrId V1 -- ZERO fulfillment writes", async () => {
    const { vndrId: v1 } = await createVendor(
      fulfillmentDb,
      { type: 'PRINT', displayName: 'Acme Print Co' },
      { operatorId },
      'trace-root-create-print-v1',
    )
    const { vndrId: v2 } = await createVendor(
      fulfillmentDb,
      { type: 'PRINT', displayName: 'Other Print Co' },
      { operatorId },
      'trace-root-create-print-v2',
    )
    const workQueue = 'wq-root-print-cross'

    // V2's OWN real class-6 credential: issued and resolved by Auth, scope.vndr = v2.
    const issuedV2 = await issueVendorCredential(
      { vndrId: v2, workQueue, permissionSetRef: 'vset:vendor_print', mode: 'test', idempotencyKey: 'root-issue-return-cross-v2' },
      opsActor,
      { db: authDb, pepper: pepperPort, traceId: 'trace-root-issue-return-v2', now: 1000 },
    )
    const claimV2 = await resolveVendorCredential(issuedV2.secret, { db: authDb, pepper, expectedMode: 'test', now: 1000 })
    expect(claimV2.cls).toBe(6)
    expect(claimV2.scope.vndr).toBe(v2)

    // a legitimate v1 unit + SENT_TO_VENDOR asgn snapshot, so the cross-vendor
    // attempt below can be proven to add NOTHING (not merely that a small
    // total exists).
    const deviceSerial = 'SER-ROOT-RETURN-CROSS'
    await seedReturnUnit(deviceSerial)
    const asgnWire = newId('asgn')
    const asgnUuid = toUuid(asgnWire)
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const merchantUuid = toUuid(newId('mrch'))
    const batchUuid = toUuid(newId('btch'))
    await seedReturnPendingEntry({
      asgnUuid,
      tenantUuid,
      programUuid,
      merchantUuid,
      batchUuid,
      traceId: 'trace-root-return-cross-snapshot',
    })

    // V2's OWN real resolved claim (scope.vndr = v2) is fed a sheet claiming
    // to be FOR v1: the class-6 own-vendor-only gate (105c) must deny on
    // scope-mismatch, exactly as
    // services/fulfillment/test/return-sheet.test.ts's fixture-claim version
    // (b) proves, but here with a REAL Auth-resolved claim on both sides of
    // the mismatch.
    const crossSheet: ReturnSheet = {
      fileId: 'file-root-return-cross',
      vndrId: v1, // the sheet claims to be FOR v1, but claimV2.scope.vndr is v2
      workQueue,
      rows: [{ deviceSerial, asgnId: asgnWire, awb: 'AWB-ROOT-CROSS' }],
    }
    const crossRes = await ingestReturnSheet(fulfillmentDb, claimV2, crossSheet, 'trace-root-return-cross-ingest')
    expect(crossRes.rejected).toBe('unauthorized')
    expect(crossRes.pairedUnitIds).toHaveLength(0)
    expect(crossRes.quarantined).toBe(0)
    expect(crossRes.shptIds).toHaveLength(0)
    expect(crossRes.deduped).toBe(false)

    // ZERO fulfillment writes: no shpt, no unit update, no intake_exception,
    // no print_for fact (authorize denies before any transaction opens, STEP
    // A of ingestReturnSheet).
    const unitRow = await fulfillmentDb.$queryRaw<{ shipment: string | null; batch: string | null }[]>`
      SELECT shipment::text AS shipment, batch::text AS batch FROM unit WHERE device_serial = ${deviceSerial}
    `
    expect(unitRow[0]!.shipment).toBeNull()
    expect(unitRow[0]!.batch).toBeNull()
    const shptCount = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM shpt`
    expect(Number(shptCount[0]!.n)).toBe(0)
    const exceptionCount = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM intake_exception`
    expect(Number(exceptionCount[0]!.n)).toBe(0)
    const printForCount = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox WHERE event_type = ${PRINT_FOR_TOPIC}`
    expect(Number(printForCount[0]!.n)).toBe(0)
    const entry = await fulfillmentDb.$queryRaw<{ dispatch_state: string | null }[]>`
      SELECT dispatch_state FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid
    `
    expect(entry[0]!.dispatch_state).toBe('SENT_TO_VENDOR') // untouched
  })
})

describe('root class-6 courier round trip: createVendor -> issueVendorCredential(vset:vendor_courier) -> resolveVendorCredential -> ingestStatusFile (checks 3, 11, S14)', () => {
  async function makeCourier(display: string, wq: string, idem: string): Promise<{ vndrId: string; claim: LeanClaim; workQueue: string }> {
    const { vndrId } = await createVendor(fulfillmentDb, { type: 'COURIER', displayName: display }, { operatorId }, `trace-create-${idem}`)
    const issued = await issueVendorCredential(
      { vndrId, workQueue: wq, permissionSetRef: 'vset:vendor_courier', mode: 'test', idempotencyKey: idem },
      opsActor,
      { db: authDb, pepper: pepperPort, traceId: `trace-issue-${idem}`, now: 1000 },
    )
    const claim = await resolveVendorCredential(issued.secret, { db: authDb, pepper, expectedMode: 'test', now: 1000 })
    return { vndrId, claim, workQueue: wq }
  }

  async function seedShptBound(awb: string, courierWire: string): Promise<void> {
    await fulfillmentDb.$executeRaw`
      INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
      VALUES (${toUuid(newId('shpt'))}::uuid, ${awb}, ${toUuid(courierWire)}::uuid, 'DISPATCHED_BY_VENDOR', now(), ${toUuid(newId('tnnt'))}::uuid, ${toUuid(newId('prog'))}::uuid, now())
    `
  }

  it('check 3: the REAL resolved courier claim (not a fixture) advances only its OWN shipments; a foreign shipment is quarantined wrong_courier; the vendor_courier set has no artifact-pull', async () => {
    const c1 = await makeCourier('Blue Dart', 'wq-courier-1', 'root-courier-1')
    expect(c1.claim.cls).toBe(6)
    expect(c1.claim.psr).toBe('vset:vendor_courier')
    expect(c1.claim.scope.vndr).toBe(c1.vndrId)

    await seedShptBound('AWB-C1', c1.vndrId)
    const ownRes = await ingestStatusFile(fulfillmentDb, {
      fileId: 'sf-own', vndrId: c1.vndrId, workQueue: c1.workQueue,
      rows: [{ awb: 'AWB-C1', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' }],
    }, c1.claim, 'trace-status-own')
    expect(ownRes.rejected).toBeUndefined()
    expect(ownRes.advanced).toBe(1)

    // (a) file-level 105c cross-vendor: a SECOND courier's real claim cannot submit a file LABELED as c1.
    const c2 = await makeCourier('Delhivery', 'wq-courier-2', 'root-courier-2')
    const impersonate = await ingestStatusFile(fulfillmentDb, {
      fileId: 'sf-impersonate', vndrId: c1.vndrId, workQueue: c1.workQueue,
      rows: [{ awb: 'AWB-C1', status: 'IN_TRANSIT', courierTimestamp: '2026-07-26T11:00:00.000Z' }],
    }, c2.claim, 'trace-status-imp')
    expect(impersonate.rejected).toBe('unauthorized')

    // (b) per-row cross-courier: c2 submits its OWN valid file, but references c1's shipment -> wrong_courier quarantine.
    const foreign = await ingestStatusFile(fulfillmentDb, {
      fileId: 'sf-foreign', vndrId: c2.vndrId, workQueue: c2.workQueue,
      rows: [{ awb: 'AWB-C1', status: 'IN_TRANSIT', courierTimestamp: '2026-07-26T11:00:00.000Z' }],
    }, c2.claim, 'trace-status-foreign')
    expect(foreign.rejected).toBeUndefined()
    expect(foreign.advanced).toBe(0)
    expect(foreign.quarantined).toBe(1)
    const q = await fulfillmentDb.$queryRaw<{ reason_code: string; channel: string }[]>`
      SELECT reason_code, channel FROM courier_status_exception
    `
    expect(q.some((x) => x.reason_code === 'wrong_courier' && x.channel === 'BATCH_FILE')).toBe(true)

    // c1's shipment stayed at PICKED_UP: c2 never moved it.
    const st = await fulfillmentDb.$queryRaw<{ status: string }[]>`SELECT status FROM shpt WHERE awb = 'AWB-C1'`
    expect(st[0]!.status).toBe('PICKED_UP')

    // structural exclusion (105d): the courier set cannot reach artifact-pull.
    const artifact = authorize(c1.claim, 'batch:pull-artifacts', { vndrId: c1.vndrId, workQueue: c1.workQueue }, loadFulfillmentConfig())
    expect(artifact.allowed).toBe(false)
  })

  it('check 11: DELIVERED is emitted and NOTHING downstream is triggered (no activation, no term_, no report projection)', async () => {
    const c = await makeCourier('Blue Dart', 'wq-courier-d', 'root-courier-d')
    await seedShptBound('AWB-D', c.vndrId)
    await ingestStatusFile(fulfillmentDb, {
      fileId: 'sf-delivered', vndrId: c.vndrId, workQueue: c.workQueue,
      rows: [{ awb: 'AWB-D', status: 'DELIVERED', courierTimestamp: '2026-07-26T12:00:00.000Z' }],
    }, c.claim, 'trace-status-delivered')

    const facts = await fulfillmentDb.$queryRaw<{ event_type: string; payload: Envelope<ShipmentFactPayload> }[]>`
      SELECT event_type, payload FROM outbox
    `
    // the DELIVERED transition fact IS emitted
    expect(facts.some((f) => f.event_type === 'fct.fulfillment.shipment.v1' && f.payload.payload.status === 'DELIVERED')).toBe(true)
    // and NOTHING downstream: every fact this courier ingest produced is a shipment
    // fact. No activation fact, no term_ binding fact, no report-projection fact.
    expect(facts.every((f) => f.event_type === 'fct.fulfillment.shipment.v1')).toBe(true)

    // structurally, no activation/term_/report table exists in the fulfillment
    // schema for DELIVERED to have written to (they are deferred to later steps).
    const tables = await fulfillmentDb.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'fulfillment' AND table_type = 'BASE TABLE'
    `
    const names = tables.map((t) => t.table_name)
    for (const downstream of ['term', 'terminal', 'activation', 'activation_report']) {
      expect(names).not.toContain(downstream)
    }
  })
})

describe('check 5: single-handle structural guarantee (projectDemandFact/triggerBatch take ONLY a FulfillmentDb)', () => {
  it('the db parameter type is exactly FulfillmentDb; a differently-shaped Prisma client (AuthDb) is a compile-time type error, verified by `pnpm typecheck` (this repo\'s tsconfig.json includes test/, unlike vitest\'s own --typecheck runner which is scoped to *.test-d.ts only)', () => {
    expectTypeOf<Parameters<typeof projectDemandFact>[0]>().toEqualTypeOf<FulfillmentDb>()
    expectTypeOf<Parameters<typeof triggerBatch>[0]>().toEqualTypeOf<FulfillmentDb>()

    // Compile-time-only: never invoked. authDb (the auth-context Prisma client,
    // a distinct generated model shape with no `.unit`/`.batch`/`.vndr`
    // delegates) cannot substitute for FulfillmentDb. If fulfillment's db
    // parameter were ever loosened (e.g. widened to `unknown` or a shared base
    // type), this line would stop erroring and `@ts-expect-error` would itself
    // fail the typecheck (an unused directive is a tsc error), so this guard is
    // self-verifying, not just descriptive.
    function typeOnlyGuard(): void {
      // @ts-expect-error authDb is Auth's own Prisma client (?schema=auth); it
      // is not a FulfillmentDb (C4: fulfillment never receives another
      // context's db handle).
      void projectDemandFact(authDb, {} as never)
      // @ts-expect-error same guard for triggerBatch's db parameter.
      void triggerBatch(authDb, 'x', 'y', 'LOT_SIZE', { epoch: 'z' })
    }
    void typeOnlyGuard

    // A runtime assertion too, so this test is not vacuous under a plain
    // `vitest run` (no --typecheck): both functions really do exist as
    // functions taking exactly the arities the type-level check above assumes.
    expect(typeof projectDemandFact).toBe('function')
    expect(projectDemandFact.length).toBe(2) // (db, env)
    expect(typeof triggerBatch).toBe('function')
    expect(triggerBatch.length).toBe(5) // (db, tenantWire, programWire, reason, opts)

    // check 5's cross-context proof (the C4 guard demonstration: a planted
    // services/tms or services/identity reference inside services/fulfillment
    // fails test/architecture.test.ts's guard D, and passes again once
    // removed) is already covered there; this test adds the single-handle
    // TYPE proof that complements it. See the Task 11 report for the guard
    // citation.
  })
})

describe('check 8: E4 trace propagates end to end from the demand fact to the batch fact', () => {
  function demandPayload(tenantWire: string, programWire: string): AssignmentFactView {
    // Task 9 (W-5): lot size counts DISTINCT source_event_id, so each
    // simulated demand fact must be its own merchant request. A shared
    // literal here collapsed every seeded row into ONE request and the
    // LOT_SIZE trigger never fired.
    const asgnId = fromUuid('asgn', toUuid(newId('asgn')))
    return {
      asgnId,
      mrchId: fromUuid('mrch', toUuid(newId('mrch'))),
      progId: programWire,
      tnntId: tenantWire,
      merchantDisplayName: 'Acme',
      merchantLegalName: 'Acme Pvt Ltd',
      merchantMcc: '5814',
      bankReferenceCode: '3',
      bankDisplayName: 'HDFC Bank',
      shipToAddress: '221B Baker Street',
      qrValue: 'upi://pay?pa=acme@hdfcbank',
      vpaValue: 'acme@hdfcbank',
      soundbox: true,
      standeeCount: 1,
      stickerCount: 2,
      billable: true,
      demandState: 'pooled-for-fulfillment',
      sourceEventId: `file-e2e|${asgnId}`,
    }
  }
  function demandEnv(payload: AssignmentFactView, dedupKey: string, traceId: string): Envelope<AssignmentFactView> {
    return newEnvelope({ type: 'fct.tms.assignment.v1', version: 1, subject: payload.asgnId, dedupKey, traceId, payload })
  }

  it('a fct.tms.assignment.v1 envelope\'s traceId survives projectDemandFact -> pending_pool_entry.trace_id -> onDemandAccrued/triggerBatch -> the emitted fct.fulfillment.batch.v1 traceId (the deterministically-oldest pooled entry, LOT_SIZE)', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const { minLotSize } = poolConfig(tenantWire, programWire)
    const knownTraceId = 'trace-e2e-demand-to-batch'

    // the FIRST demand fact, carrying the known traceId, must be the
    // chronologically OLDEST pending_pool_entry row: the batch fact must carry
    // ITS trace, per triggerBatch's documented "deterministically-oldest
    // claimed entry" rule. Unlike services/fulfillment/test/batching-lotsize.test.ts's
    // own fixtures (which control created_at directly via a raw SQL INSERT),
    // this test drives the REAL projectDemandFact path end to end, so it relies
    // on genuine wall-clock ordering instead: the known-trace row is written
    // first and a real gap is waited out before any other row is written, so
    // there is no tie for projectDemandFact's `now()`-defaulted created_at to
    // break ambiguously.
    const firstPayload = demandPayload(tenantWire, programWire)
    const firstEnv = demandEnv(firstPayload, 'evt-e2e-0|fulfillment.pool', knownTraceId)
    const firstRes = await projectDemandFact(fulfillmentDb, firstEnv)
    expect(firstRes.deduped).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 20))

    for (let i = 1; i < minLotSize; i++) {
      const payload = demandPayload(tenantWire, programWire)
      const env = demandEnv(payload, `evt-e2e-${String(i)}|fulfillment.pool`, `trace-e2e-other-${String(i)}`)
      const res = await projectDemandFact(fulfillmentDb, env)
      expect(res.deduped).toBe(false)
    }

    // sanity: the known-trace row really did land with the earliest created_at
    // among the pool (proves the ordering assumption the assertion below
    // depends on, rather than asserting it blindly).
    const oldestRow = await fulfillmentDb.$queryRaw<{ trace_id: string }[]>`
      SELECT trace_id FROM pending_pool_entry
      WHERE tenant_id = ${toUuid(tenantWire)}::uuid AND program_id = ${toUuid(programWire)}::uuid
      ORDER BY created_at ASC, id ASC LIMIT 1
    `
    expect(oldestRow[0]!.trace_id).toBe(knownTraceId)

    const trigger = await onDemandAccrued(fulfillmentDb, tenantWire, programWire, 'dedup-e2e-trigger', 'trace-triggering-e2e')
    expect(trigger.triggered).toBe(true)
    expect(trigger.btchId).toBeDefined()

    const ob = await fulfillmentDb.$queryRaw<BatchOutboxRow[]>`
      SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${BATCH_TOPIC}
    `
    expect(ob).toHaveLength(1)
    // the demand fact's OWN traceId (not the triggering call's 'trace-triggering-e2e')
    // survived, end to end, onto the batch fact.
    expect(ob[0]!.payload.traceId).toBe(knownTraceId)
    expect(ob[0]!.payload.payload.triggerReason).toBe('LOT_SIZE')
    expect(ob[0]!.payload.payload.unitCount).toBe(minLotSize)
  })
})
