import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '../generated/client/index.js'
import { issueRefreshFamily, rotateRefresh } from '../src/refresh.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
const db = new PrismaClient({ datasourceUrl: url })

beforeAll(async () => {
  await db.$connect()
})
afterAll(async () => {
  await db.$disconnect()
})
// No reset: every test below mints its own random principalId and asserts only
// against rows for that principal, so there is nothing to clean up. The previous
// unfiltered deleteMany({}) revoked the refresh families of anyone signed in to
// the ops portal against this shared dev database.

describe('D3 refresh-token family (6b, check 3)', () => {
  it('a normal rotation issues a new token and marks the old one used', async () => {
    const principalId = randomUUID()
    const { refreshToken: r0 } = await issueRefreshFamily(principalId, 'client-A', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 })
    const { refreshToken: r1 } = await rotateRefresh(r0, { db, idleSec: 1800, now: 1100 })
    expect(r1).not.toBe(r0)
    const rows = await db.refreshToken.findMany({ where: { principalId } })
    expect(rows.filter((x) => x.used)).toHaveLength(1)
    expect(rows.filter((x) => !x.used && !x.revoked)).toHaveLength(1)
  })

  it('REUSE of a rotated token revokes the entire family (anti-replay)', async () => {
    const principalId = randomUUID()
    const { refreshToken: r0, familyId } = await issueRefreshFamily(principalId, 'client-A', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 })
    const { refreshToken: r1 } = await rotateRefresh(r0, { db, idleSec: 1800, now: 1100 })
    // An attacker replays the already-rotated r0: reuse detected, whole family revoked.
    await expect(rotateRefresh(r0, { db, idleSec: 1800, now: 1200 })).rejects.toThrow()
    // The legitimate holder's r1 is now dead too, because the family is revoked.
    await expect(rotateRefresh(r1, { db, idleSec: 1800, now: 1300 })).rejects.toThrow()
    const rows = await db.refreshToken.findMany({ where: { familyId } })
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.every((x) => x.revoked)).toBe(true)
  })

  it('rejects a refresh past its idle bound', async () => {
    const principalId = randomUUID()
    const { refreshToken: r0 } = await issueRefreshFamily(principalId, 'client-A', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 })
    await expect(rotateRefresh(r0, { db, idleSec: 1800, now: 1000 + 1801 })).rejects.toThrow()
  })

  it('rejects a refresh past its absolute bound even while idle stays fresh', async () => {
    const principalId = randomUUID()
    // issue@1000: idle->2800, absolute->4600 (inherited across rotations).
    const { refreshToken: r0 } = await issueRefreshFamily(principalId, 'client-A', { db, idleSec: 1800, absoluteSec: 3600, now: 1000 })
    const { refreshToken: r1 } = await rotateRefresh(r0, { db, idleSec: 1800, now: 2500 }) // idle ok, new idle->4300
    const { refreshToken: r2 } = await rotateRefresh(r1, { db, idleSec: 1800, now: 4000 }) // idle ok, new idle->5800
    // now=4700 is within idle (5800) but past the family absolute bound (4600).
    await expect(rotateRefresh(r2, { db, idleSec: 1800, now: 4700 })).rejects.toThrow()
  })
})
