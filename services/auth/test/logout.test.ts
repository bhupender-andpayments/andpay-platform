import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient, type AuthDb, issueRefreshFamily, rotateRefresh, logoutFamily } from '../src/index.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
let db: AuthDb
const principalId = randomUUID()

beforeAll(() => { db = new PrismaClient({ datasourceUrl: url }) })
afterAll(async () => { await db.$disconnect() })
beforeEach(async () => {
  await db.$executeRawUnsafe(`DELETE FROM refresh_token WHERE principal_id = '${principalId}'`)
  await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = '${principalId}'`)
})

describe('logout family-revoke (spec 12 task 5)', () => {
  it('revokes the whole family, co-commits one logout audit, and a subsequent rotate 401s', async () => {
    const { refreshToken, familyId } = await issueRefreshFamily(principalId, 'cb', { db, idleSec: 1800, absoluteSec: 28800 })
    await logoutFamily(db, { principalId, familyId, traceId: randomUUID() })
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM outbox WHERE event_type='authz.audit' AND aggregate_id='${principalId}'`)
    expect(Number(rows[0]!.n)).toBe(1)
    await expect(rotateRefresh(refreshToken, { db, idleSec: 1800 })).rejects.toThrow('refresh-revoked')
  })
})
