import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { GENESIS_PREV_HASH, type AuthzAuditRecord } from '@andpay/audit'
import { PrismaClient } from '../generated/client/index.js'
import { appendAuthzAudit, consumeAuthzAudit, AUTHZ_AUDIT_CONSUMER } from '../src/authz-chain.js'
import { verifyAuthzChain } from '../src/authz-chain-verify.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
const db = new PrismaClient({ datasourceUrl: url })

function rec(overrides: Partial<AuthzAuditRecord> = {}): AuthzAuditRecord {
  return {
    principalId: 'prn_x',
    cls: 3,
    operation: 'login',
    decision: 'ALLOW',
    outcome: 'ok',
    traceId: 't',
    ...overrides,
  }
}

interface HeadRow {
  seq: bigint
  prev_hash: string
  entry_hash: string
}

beforeAll(async () => {
  await db.$connect()
})
afterAll(async () => {
  await db.$disconnect()
})
// The table has no other writer in this suite, so a full DELETE isolates
// each test (it stays append-only in production; tests reset it directly).
// The E6 dedup row lives in the separate inbox table, not authz_audit, and
// persists across runs; clearing this consumer's rows too keeps the suite
// re-runnable (otherwise a rerun's literal event ids collide with a prior
// run's already-processed dedup keys and every append silently no-ops).
beforeEach(async () => {
  await db.$executeRaw`DELETE FROM authz_audit`
  await db.$executeRaw`DELETE FROM inbox WHERE consumer = ${AUTHZ_AUDIT_CONSUMER}`
})

describe('6e authz_audit tamper-evident hash-chain (task 2)', () => {
  it('appends an ordered gap-free chain starting at seq 1, each entry chaining the prior hash', async () => {
    const evs = [
      rec({ operation: 'login' }),
      rec({ decision: 'DENY', operation: 'authorize', outcome: 'denied', reasonCode: 'scope-denied' }),
      rec({ operation: 'vendor_credential:create', resourceIds: ['api_1', 'vndr_1'] }),
    ]
    for (const [i, r] of evs.entries()) {
      const result = await db.$transaction((tx) => appendAuthzAudit(tx, r, `evt-append-${i}`))
      expect(result.appended).toBe(true)
    }
    const rows = await db.$queryRaw<HeadRow[]>`SELECT seq, prev_hash, entry_hash FROM authz_audit ORDER BY seq ASC`
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3])
    expect(rows[0]!.prev_hash).toBe(GENESIS_PREV_HASH)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.entry_hash)
    }
  })

  it('the integrity job passes end to end and flags a planted tamper at the exact seq', async () => {
    for (let i = 0; i < 3; i++) {
      await db.$transaction((tx) => appendAuthzAudit(tx, rec({ operation: `op-${i}` }), `evt-integrity-${i}`))
    }
    expect((await verifyAuthzChain(db)).ok).toBe(true)
    // Plant a tamper: flip one stored entry_hash directly.
    await db.$executeRaw`UPDATE authz_audit SET entry_hash = ${'f'.repeat(64)} WHERE seq = 2`
    const broken = await verifyAuthzChain(db)
    expect(broken.ok).toBe(false)
    expect(broken.brokenAtSeq).toBe(2)
  })

  it('a redelivered authz-audit event does NOT double-append (E6 dedup on event id)', async () => {
    const before = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM authz_audit`
    const first = await db.$transaction((tx) => appendAuthzAudit(tx, rec({ operation: 'once' }), 'evt-dup'))
    const second = await db.$transaction((tx) => appendAuthzAudit(tx, rec({ operation: 'once' }), 'evt-dup'))
    expect(first.appended).toBe(true)
    expect(second.appended).toBe(false)
    const after = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM authz_audit`
    expect(Number(after[0]!.n) - Number(before[0]!.n)).toBe(1)
  })

  it('a record with authTime, resourceIds, and actorChannel set round-trips exactly (verifyAuthzChain stays ok)', async () => {
    await db.$transaction((tx) =>
      appendAuthzAudit(
        tx,
        rec({
          operation: 'vendor_credential:create',
          resourceIds: ['api_9', 'vndr_9'],
          authTime: 1_700_000_000,
          actorChannel: 'human-via-ai',
          acr: 'AAL2',
          asserterSvid: 'svid:agent-1',
        }),
        'evt-roundtrip',
      ),
    )
    const result = await verifyAuthzChain(db)
    expect(result.ok).toBe(true)
    expect(result.length).toBe(1)
  })

  it('a record with a FRACTIONAL authTime round-trips exactly (no false brokenAtSeq from truncation)', async () => {
    await db.$transaction((tx) => appendAuthzAudit(tx, rec({ operation: 'op-before' }), 'evt-frac-before'))
    await db.$transaction((tx) =>
      appendAuthzAudit(tx, rec({ operation: 'op-fractional', authTime: 1_700_000_000.75 }), 'evt-frac-mid'),
    )
    await db.$transaction((tx) => appendAuthzAudit(tx, rec({ operation: 'op-after' }), 'evt-frac-after'))
    const result = await verifyAuthzChain(db)
    expect(result).toEqual({ ok: true, length: 3 })
  })

  it('two overlapping appenders serialize via the advisory lock: no duplicate seq, no forked chain', async () => {
    const results = await Promise.all([
      db.$transaction((tx) => appendAuthzAudit(tx, rec({ operation: 'concurrent-a' }), 'evt-conc-a')),
      db.$transaction((tx) => appendAuthzAudit(tx, rec({ operation: 'concurrent-b' }), 'evt-conc-b')),
    ])
    const seqs = results.map((r) => r.seq).sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(seqs).toEqual([1, 2])
    const check = await verifyAuthzChain(db)
    expect(check.ok).toBe(true)
    expect(check.length).toBe(2)
  })
})

describe('consumeAuthzAudit (task 8: the 6e consumer wiring emit->append, dedup on the DELIVERED payload.id)', () => {
  it('appends the record carried by the payload, dedupping on payload.id (not a freshly-minted id)', async () => {
    const payload = { id: 'evt-consume-1', ...rec({ operation: 'consume-once' }) }
    const first = await consumeAuthzAudit(db, payload)
    expect(first.appended).toBe(true)
    expect(first.seq).toBe(1)

    const rows = await db.$queryRaw<{ operation: string }[]>`SELECT operation FROM authz_audit WHERE seq = 1`
    expect(rows[0]!.operation).toBe('consume-once')

    // A redelivery of the SAME payload (same id) must NOT double-append: this
    // is the whole point of dedupping on the delivered id rather than minting
    // a fresh one per call.
    const redelivered = await consumeAuthzAudit(db, payload)
    expect(redelivered.appended).toBe(false)
    const count = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM authz_audit`
    expect(Number(count[0]!.n)).toBe(1)
  })

  it('two DIFFERENT payload ids both append, chaining correctly', async () => {
    await consumeAuthzAudit(db, { id: 'evt-consume-a', ...rec({ operation: 'op-a' }) })
    await consumeAuthzAudit(db, { id: 'evt-consume-b', ...rec({ operation: 'op-b' }) })
    const check = await verifyAuthzChain(db)
    expect(check.ok).toBe(true)
    expect(check.length).toBe(2)
  })
})
