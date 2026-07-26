import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { GENESIS_PREV_HASH, type AuthzAuditRecord } from '@andpay/audit'
import {
  PrismaClient as AuthClient,
  emitAuthzAudit,
  consumeAuthzAudit,
  verifyAuthzChain,
  AUTHZ_AUDIT_CONSUMER,
} from '@andpay/auth-service'
import { PrismaClient as FulfillmentClient, emitVendorAuthzAudit } from '@andpay/fulfillment-service'

// Root-only integration seam (mirrors test/fulfillment_auth_roundtrip.test.ts's
// precedent): this is the ONE place proving the REAL C4 flow end to end --
// "the edge emits an event, AUTH appends" -- across two separate contexts, two
// separate Prisma clients, two separate schemas, joined only by the delivered
// outbox payload. Auth is the SOLE appender: it consumes authz.audit events
// from BOTH its own outbox (emitAuthzAudit) AND every context edge's outbox
// (here, fulfillment's emitVendorAuthzAudit), through the ONE dedicated
// channel and the ONE consumeAuthzAudit consumer (task 8, check 2).
const authUrl =
  process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const authDb = new AuthClient({ datasourceUrl: authUrl })
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })

beforeEach(async () => {
  // authz_audit (the chain itself), the AUTHZ_AUDIT_CONSUMER's own inbox rows
  // (E6 dedup), and both outboxes this test reads from (auth's own, and
  // fulfillment's, the edge-side emitter).
  await authDb.$executeRaw`DELETE FROM authz_audit`
  await authDb.$executeRawUnsafe(`DELETE FROM inbox WHERE consumer = '${AUTHZ_AUDIT_CONSUMER}'`)
  await authDb.$executeRawUnsafe('TRUNCATE outbox')
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE outbox, inbox')
})
afterAll(async () => {
  await authDb.$disconnect()
  await fulfillmentDb.$disconnect()
})

function record(overrides: Partial<AuthzAuditRecord> = {}): AuthzAuditRecord {
  return {
    principalId: 'prn_e2e',
    cls: 3,
    operation: 'login',
    decision: 'ALLOW',
    outcome: 'ok',
    traceId: 'trace-e2e',
    ...overrides,
  }
}

interface AuditOutboxRow {
  payload: { id: string } & AuthzAuditRecord
}

async function readAuditOutbox(
  db: AuthClient | FulfillmentClient,
): Promise<AuditOutboxRow[]> {
  return db.$queryRaw<AuditOutboxRow[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC
  `
}

describe('check 2 end-to-end: the edge/auth emits authz.audit, Auth alone appends it to the tamper-evident hash-chain (task 8)', () => {
  it('an authn ALLOW (auth outbox), a DENY (auth outbox), and a courier-edge decision (fulfillment outbox) are each consumed by consumeAuthzAudit into ONE gap-free chain of exactly 3 entries; verifyAuthzChain reports ok; a redelivery of one payload does NOT double-append', async () => {
    // (a) an authn-style ALLOW, emitted via Auth's OWN emitAuthzAudit (its own
    // outbox), exactly as services/auth/src/login.ts does on a successful login.
    await authDb.$transaction(async (tx) => {
      await emitAuthzAudit(tx, record({ principalId: 'prn_allow', operation: 'login', decision: 'ALLOW', outcome: 'ok', traceId: 'trace-e2e-allow' }))
    })

    // (b) a DENY, also via Auth's own emitAuthzAudit (its own outbox), exactly
    // as services/auth/src/authorize.ts's authorizeAudited does on a denial.
    await authDb.$transaction(async (tx) => {
      await emitAuthzAudit(
        tx,
        record({
          principalId: 'prn_deny',
          operation: 'mfa:reset',
          decision: 'DENY',
          outcome: 'denied',
          reasonCode: 'permission-denied',
          traceId: 'trace-e2e-deny',
        }),
      )
    })

    // (c) a courier-edge decision, emitted via Fulfillment's OWN
    // emitVendorAuthzAudit (the fulfillment outbox, a DIFFERENT schema/db
    // entirely): the real C4 "the edge emits, Auth appends" path, not a
    // same-schema shortcut.
    await emitVendorAuthzAudit(fulfillmentDb, record({
      principalId: 'api_courier_1',
      cls: 6,
      operation: 'shipment:submit-status',
      decision: 'ALLOW',
      outcome: 'authorized',
      actorChannel: 'vendor-edge',
      traceId: 'trace-e2e-edge',
    }))

    const authRows = await readAuditOutbox(authDb)
    expect(authRows).toHaveLength(2)
    const fulfillmentRows = await readAuditOutbox(fulfillmentDb)
    expect(fulfillmentRows).toHaveLength(1)

    // Sanity: the chain starts empty.
    const before = await verifyAuthzChain(authDb)
    expect(before).toEqual({ ok: true, length: 0 })

    // Consume all three delivered payloads, in emission order, through the
    // ONE Auth-side consumer. This is the "AUTH is the sole appender" proof:
    // consumeAuthzAudit is invoked identically regardless of which context's
    // outbox the payload came from.
    const deliveries = [...authRows, ...fulfillmentRows]
    const results = []
    for (const row of deliveries) {
      results.push(await consumeAuthzAudit(authDb, row.payload))
    }
    expect(results.every((r) => r.appended)).toBe(true)
    expect(results.map((r) => r.seq)).toEqual([1, 2, 3])

    // The chain grew by exactly 3, gap-free, each prev_hash chaining the
    // prior entry_hash, and the lowest-seq row chains from GENESIS_PREV_HASH.
    const chainRows = await authDb.$queryRaw<{ seq: bigint; prev_hash: string; entry_hash: string }[]>`
      SELECT seq, prev_hash, entry_hash FROM authz_audit ORDER BY seq ASC
    `
    expect(chainRows).toHaveLength(3)
    expect(chainRows[0]!.prev_hash).toBe(GENESIS_PREV_HASH)
    for (let i = 1; i < chainRows.length; i++) {
      expect(chainRows[i]!.prev_hash).toBe(chainRows[i - 1]!.entry_hash)
    }

    const verified = await verifyAuthzChain(authDb)
    expect(verified.ok).toBe(true)
    expect(verified.length).toBe(3)

    // Re-consuming one of the SAME delivered payloads (identical payload.id,
    // never a fresh id) must be a no-op: no double-append, count stable.
    const redelivered = await consumeAuthzAudit(authDb, authRows[0]!.payload)
    expect(redelivered.appended).toBe(false)
    const countAfter = await authDb.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM authz_audit`
    expect(Number(countAfter[0]!.n)).toBe(3)
    const verifiedAfter = await verifyAuthzChain(authDb)
    expect(verifiedAfter.ok).toBe(true)
    expect(verifiedAfter.length).toBe(3)
  })
})
