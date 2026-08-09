import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { LeanClaim } from '@andpay/authz'
import type { AuthzAuditRecord } from '@andpay/audit'
import { PrismaClient } from '../generated/client/index.js'
import { pullDispatchPackageXlsx, PullDeniedError } from '../src/vendor-pull.js'

// Spec 14b Task 5: the FR-04 dispatch-package pull, a D104 PII-disclosure
// surface. Proves: (1) an own-vndr pull returns a real .xlsx AND emits a
// durable ALLOW disclosure audit that is IDs-and-enums only; (2) a cross-vndr
// pull is denied (no xlsx) AND emits a durable DENY audit; (3) no ship-to
// address string is ever written to a log line (S7/D104, never persisted,
// never logged).
const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, unit, composed_artifact, pending_pool_entry, batch, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

function mkClaim7(vndrWire: string): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: 'op_test',
    aud: 'andpay:vendor',
    iat: 0,
    exp: 0,
    nbf: 0,
    jti: 'jti-test',
    cls: 7,
    mode: 'live',
    scope: { vndr: vndrWire },
    psr: 'vset:vendor_operator',
    epoch: 0,
    acr: 'AAL2',
    amr: ['pwd', 'otp'],
  }
}

const SHIP_TO_ADDRESS = '221B Baker Street, Marylebone'

interface Seeded {
  btchV1Wire: string
  v1Wire: string
  v2Wire: string
}

// Seeds B1 (print_vndr=V1) with one pending_pool_entry (carrying the
// recipient PII fields) and one composed_artifact row.
async function seed(): Promise<Seeded> {
  const v1Wire = newId('vndr')
  const v1Uuid = toUuid(v1Wire)
  const v2Wire = newId('vndr')
  const tnnt = toUuid(newId('tnnt'))
  const prog = toUuid(newId('prog'))

  const btchV1Wire = newId('btch')
  const btchV1Uuid = toUuid(btchV1Wire)

  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, print_vndr, status, trigger_reason, triggered_by_actor, unit_count, updated_at)
    VALUES (${btchV1Uuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, ${v1Uuid}::uuid, 'BORN', 'LOT_SIZE', NULL, 1, now())
  `

  const entryV1 = toUuid(newId('asgn'))
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, ship_to_contact_name, ship_to_mobile, qr_value, vpa_value, pool_status, batch, dispatch_state,
      source_event_id, trace_id, updated_at
    ) VALUES (
      ${entryV1}::uuid, ${tnnt}::uuid, ${prog}::uuid, true, 1, 0, true,
      'Acme Store', 'Acme Pvt Ltd', '5814', 'HDFC-001', 'HDFC Bank',
      ${SHIP_TO_ADDRESS}, 'Sherlock Holmes', '9999999999', 'acme@hdfcbank', 'acme@hdfcbank', 'BATCHED',
      ${btchV1Uuid}::uuid, 'SENT_TO_VENDOR', 'evt-1', 'trace-1', now()
    )
  `

  await db.$executeRaw`
    INSERT INTO composed_artifact (
      asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference,
      label_display_name, label_qr, created_at
    ) VALUES (
      ${entryV1}::uuid, ${btchV1Uuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, 'SOUNDBOX_IMG', 's3://labels/acme-1.pdf',
      'Acme Store', 'acme@hdfcbank', now()
    )
  `

  return { btchV1Wire: fromUuid('btch', btchV1Uuid), v1Wire, v2Wire }
}

async function readOutboxAuthzAudits(): Promise<AuthzAuditRecord[]> {
  const rows = await db.$queryRaw<{ payload: AuthzAuditRecord }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit'
  `
  return rows.map((r) => r.payload)
}

describe('pullDispatchPackageXlsx (spec 14b task 5, FR-04 D104 disclosure surface)', () => {
  it('streams the ship-view .xlsx for an own batch and emits an ALLOW disclosure audit', async () => {
    const { btchV1Wire, v1Wire } = await seed()
    const claim = mkClaim7(v1Wire)

    const res = await pullDispatchPackageXlsx(db, claim, btchV1Wire, 'trace-1')

    expect(res.xlsx).toBeInstanceOf(Buffer)
    expect(res.xlsx.length).toBeGreaterThan(0)
    // a real xlsx is a PK zip; the first two bytes prove it, not a stub buffer.
    expect(res.xlsx.subarray(0, 2).toString('latin1')).toBe('PK')
    expect(res.btchId).toBe(btchV1Wire)

    const audits = await readOutboxAuthzAudits()
    const allow = audits.find((a) => a.operation === 'batch:pull-artifacts' && a.decision === 'ALLOW')
    expect(allow).toBeTruthy()
    expect(allow!.outcome).toBe('authorized')
    expect(allow!.resourceIds).toEqual([v1Wire, btchV1Wire])
    expect(allow!.actorChannel).toBe('vendor-edge')
    expect(allow!.traceId).toBe('trace-1')
    // IDs-and-enums only: never the recipient PII, never a package row.
    const json = JSON.stringify(allow)
    expect(json).not.toMatch(/Sherlock|Baker Street|9999999999/)
  })

  it('rejects a cross-vndr pull with a DENY audit and no xlsx', async () => {
    const { btchV1Wire, v2Wire } = await seed()
    const claim = mkClaim7(v2Wire) // V2 pulling B1 (V1's batch)

    await expect(pullDispatchPackageXlsx(db, claim, btchV1Wire, 'trace-2')).rejects.toThrow(PullDeniedError)

    const audits = await readOutboxAuthzAudits()
    const deny = audits.find((a) => a.operation === 'batch:pull-artifacts' && a.decision === 'DENY')
    expect(deny).toBeTruthy()
    expect(deny!.outcome).toBe('denied')
    expect(deny!.reasonCode).toBeTruthy()
    expect(deny!.traceId).toBe('trace-2')
    const json = JSON.stringify(deny)
    expect(json).not.toMatch(/Sherlock|Baker Street|9999999999/)
  })

  it('never logs the ship-to address, contact name, or mobile for an own-vndr pull', async () => {
    const { btchV1Wire, v1Wire } = await seed()
    const claim = mkClaim7(v1Wire)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await pullDispatchPackageXlsx(db, claim, btchV1Wire, 'trace-3')
    } finally {
      const allCalls = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map((a) => JSON.stringify(a))
        .join('\n')
      logSpy.mockRestore()
      errSpy.mockRestore()
      warnSpy.mockRestore()
      expect(allCalls).not.toMatch(/Sherlock|Baker Street|9999999999/)
    }
  })
})

// D-9b: the CLASS-6 pull, which had never once been exercised.
//
// Both test layers for this route minted class 7, where the work-queue axis is
// skipped, so nobody noticed that class 6 could not pull AT ALL: vendor-pull.ts
// passed a resource with no workQueue while class 6 enforced that axis, and
// `credential_projection.work_queue` is NOT NULL, so a class-6 claim always
// carried one and `undefined !== 'wq-x'` denied every time, by construction.
//
// The corpus grants `batch:pull-artifacts` to the class-6 MANUFACTURER and PRINT
// sets, so the code was contradicting its own grant. These tests pin that a
// class-6 vendor can pull its OWN batch and still cannot touch anyone else's.
function mkClaim6(vndrWire: string, workQueue: string): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: 'api_test',
    aud: 'andpay:vendor',
    iat: 0,
    exp: 0,
    nbf: 0,
    jti: 'jti-test-6',
    cls: 6,
    mode: 'live',
    // A class-6 credential ALWAYS carries a work queue: the column is NOT NULL.
    // That is exactly what used to make this path impossible.
    scope: { vndr: vndrWire, wq: workQueue },
    psr: 'vendor_print',
    epoch: 0,
  } as unknown as LeanClaim
}

describe('D-9b: the class-6 pull works, and stays vendor-isolated', () => {
  it('lets a class-6 print vendor pull its OWN batch, with an ALLOW audit', async () => {
    const { btchV1Wire, v1Wire } = await seed()
    const claim = mkClaim6(v1Wire, 'wq-print')

    const res = await pullDispatchPackageXlsx(db, claim, btchV1Wire, 'trace-c6')

    expect(res.xlsx.subarray(0, 2).toString('latin1')).toBe('PK')
    const allow = (await readOutboxAuthzAudits()).find(
      (a) => a.operation === 'batch:pull-artifacts' && a.decision === 'ALLOW',
    )
    expect(allow).toBeTruthy()
    expect(allow!.cls).toBe(6)
  })

  it('works whatever the credential work queue happens to be', async () => {
    // The axis is off for pull, so the specific queue is irrelevant. Pinning
    // this stops someone "fixing" it later by matching a queue that a batch
    // does not have.
    const { btchV1Wire, v1Wire } = await seed()
    for (const wq of ['wq-print', 'wq-anything-else', 'wq-map-a']) {
      const res = await pullDispatchPackageXlsx(db, mkClaim6(v1Wire, wq), btchV1Wire, `trace-${wq}`)
      expect(res.xlsx.subarray(0, 2).toString('latin1')).toBe('PK')
    }
  })

  it('STILL rejects a cross-vndr class-6 pull: isolation is the vndr axis, not the queue', async () => {
    // The load-bearing half. Switching off the work-queue axis must not have
    // opened the door for one vendor to read another's batch.
    const { btchV1Wire, v2Wire } = await seed()
    const claim = mkClaim6(v2Wire, 'wq-print')

    await expect(pullDispatchPackageXlsx(db, claim, btchV1Wire, 'trace-c6-cross')).rejects.toThrow(PullDeniedError)

    const deny = (await readOutboxAuthzAudits()).find(
      (a) => a.operation === 'batch:pull-artifacts' && a.decision === 'DENY',
    )
    expect(deny).toBeTruthy()
    expect(deny!.reasonCode).toBe('scope-denied')
  })

  it('still denies a class-6 vendor set that lacks the permission', async () => {
    // The permission gate is untouched: only the SCOPE axis changed. A courier
    // is deliberately excluded from artifact pull (105d) and must stay excluded.
    const { btchV1Wire, v1Wire } = await seed()
    const courier = { ...mkClaim6(v1Wire, 'wq-print'), psr: 'vendor_courier' } as LeanClaim

    await expect(pullDispatchPackageXlsx(db, courier, btchV1Wire, 'trace-c6-courier')).rejects.toThrow(PullDeniedError)
    const deny = (await readOutboxAuthzAudits()).find((a) => a.decision === 'DENY')
    expect(deny!.reasonCode).toBe('permission-denied')
  })
})
