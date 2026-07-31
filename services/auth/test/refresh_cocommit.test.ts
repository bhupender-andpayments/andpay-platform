import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient, type AuthDb, issueRefreshFamily, rotateRefresh } from '../src/index.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
let db: AuthDb
const principalId = randomUUID()

async function auditCount(pid: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM outbox WHERE event_type = 'authz.audit' AND aggregate_id = '${pid}'`,
  )
  return Number(rows[0]!.n)
}

beforeAll(() => { db = new PrismaClient({ datasourceUrl: url }) })
afterAll(async () => { await db.$disconnect() })
beforeEach(async () => {
  await db.$executeRawUnsafe(`DELETE FROM refresh_token WHERE principal_id = '${principalId}'`)
  await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = '${principalId}'`)
})

describe('refresh 6e co-commit (spec 12 task 3)', () => {
  it('issueRefreshFamily with an audit record commits the family AND exactly one authz.audit atomically', async () => {
    const rec = { principalId, cls: 3 as const, operation: 'login', decision: 'ALLOW' as const, resourceIds: [], outcome: 'authenticated', acr: 'AAL2' as const, traceId: randomUUID() }
    await issueRefreshFamily(principalId, 'cb', { db, idleSec: 1800, absoluteSec: 28800, audit: rec })
    expect(await auditCount(principalId)).toBe(1)
    const fam = await db.refreshToken.count({ where: { principalId } })
    expect(fam).toBe(1)
  })

  it('rotateRefresh emits one refresh audit co-committed with the successor mint', async () => {
    const { refreshToken } = await issueRefreshFamily(principalId, 'cb', { db, idleSec: 1800, absoluteSec: 28800 })
    await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = '${principalId}'`) // isolate the rotate audit
    const rec = { principalId, cls: 3 as const, operation: 'refresh', decision: 'ALLOW' as const, resourceIds: [], outcome: 'rotated', traceId: randomUUID() }
    await rotateRefresh(refreshToken, { db, idleSec: 1800, audit: rec })
    expect(await auditCount(principalId)).toBe(1)
  })

  it('a reused (rotated) refresh token revokes the family AND co-commits a reuse-revoke audit, throwing after', async () => {
    const { refreshToken } = await issueRefreshFamily(principalId, 'cb', { db, idleSec: 1800, absoluteSec: 28800 })
    await rotateRefresh(refreshToken, { db, idleSec: 1800 }) // marks it used
    await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = '${principalId}'`)
    const revokeRec = { principalId, cls: 3 as const, operation: 'refresh', decision: 'DENY' as const, resourceIds: [], outcome: 'family-revoked', reasonCode: 'refresh-reuse', traceId: randomUUID() }
    await expect(rotateRefresh(refreshToken, { db, idleSec: 1800, revokeAudit: revokeRec })).rejects.toThrow('refresh-reuse-family-revoked')
    expect(await auditCount(principalId)).toBe(1) // the revoke audit committed even though the call threw
    const revokedAll = await db.refreshToken.findMany({ where: { principalId } })
    expect(revokedAll.every((r) => r.revoked)).toBe(true)
  })
})
