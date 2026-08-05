import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient, type AuthDb, issueRefreshFamily, rotateRefresh, rehydrateSession, loadConfig } from '../src/index.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
let db: AuthDb
const cfg = loadConfig()

beforeAll(() => { db = new PrismaClient({ datasourceUrl: url }) })
afterAll(async () => { await db.$disconnect() })

// A fresh principal + its refresh family per test (random ids, so no cross-test
// contamination and no shared cleanup needed; every query below filters by the
// test's own principalId).
async function seedPrincipal(status = 'ACTIVE', role = 'admin'): Promise<string> {
  const id = randomUUID()
  await db.internalPrincipal.create({
    data: { id, loginHandle: `rh-${id.slice(0, 8)}`, passwordHash: 'x', status, role },
  })
  return id
}

interface AuditRow { decision: string; principalId: string; operation: string; acr: string | null }
async function audits(pid: string): Promise<AuditRow[]> {
  return db.$queryRawUnsafe<AuditRow[]>(
    `SELECT payload->>'decision' AS decision, payload->>'principalId' AS "principalId", ` +
      `payload->>'operation' AS operation, payload->>'acr' AS acr ` +
      `FROM outbox WHERE event_type = 'authz.audit' AND aggregate_id = '${pid}'`,
  )
}

describe('rehydrateSession (Phase 7 GATE 2, S1)', () => {
  it('rehydrates from the cookie alone: rotates and returns the family principal + re-derived role/acr', async () => {
    const principalId = await seedPrincipal('ACTIVE', 'admin')
    const { refreshToken: r0 } = await issueRefreshFamily(principalId, 'cb', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 })

    const res = await rehydrateSession(r0, { db, roleConfig: cfg, idleSec: 1800, now: 1100, traceId: randomUUID() })

    expect(res.refreshToken).not.toBe(r0)
    expect(res.principalId).toBe(principalId)
    expect(res.role).toBe('admin')
    expect(res.acr).toBe(cfg.roles.admin!.requiredAcr)
    // The rotated successor is a live, unused token; the presented one is spent.
    const rows = await db.refreshToken.findMany({ where: { principalId } })
    expect(rows.filter((x) => x.used)).toHaveLength(1)
    expect(rows.filter((x) => !x.used && !x.revoked)).toHaveLength(1)
  })

  it('co-commits exactly one refresh-ALLOW audit with principalId = the family principal', async () => {
    const principalId = await seedPrincipal('ACTIVE', 'admin')
    const { refreshToken: r0 } = await issueRefreshFamily(principalId, 'cb', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 })
    // Isolate the rehydrate audit from the family-create (no audit was passed to
    // issueRefreshFamily above, so the outbox already holds none for this pid).
    await rehydrateSession(r0, { db, roleConfig: cfg, idleSec: 1800, now: 1100, traceId: randomUUID() })

    const rows = await audits(principalId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.operation).toBe('refresh')
    expect(rows[0]!.principalId).toBe(principalId)
    expect(rows[0]!.acr).toBe(cfg.roles.admin!.requiredAcr)
  })

  it('a reused (already-rotated) token revokes the whole family AND co-commits a DENY audit', async () => {
    const principalId = await seedPrincipal('ACTIVE', 'admin')
    const { refreshToken: r0, familyId } = await issueRefreshFamily(principalId, 'cb', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 })
    await rotateRefresh(r0, { db, idleSec: 1800, now: 1100 }) // marks r0 used
    // Replaying r0 through rehydrate is reuse: family revoked, DENY audit committed, throws.
    await expect(rehydrateSession(r0, { db, roleConfig: cfg, idleSec: 1800, now: 1200, traceId: randomUUID() })).rejects.toThrow()
    const rows = await db.refreshToken.findMany({ where: { familyId } })
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.every((x) => x.revoked)).toBe(true)
    const a = await audits(principalId)
    expect(a).toHaveLength(1)
    expect(a[0]!.decision).toBe('DENY')
  })

  it('an idle-expired token 401s (throws), no successor minted', async () => {
    const principalId = await seedPrincipal('ACTIVE', 'admin')
    const { refreshToken: r0 } = await issueRefreshFamily(principalId, 'cb', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 })
    await expect(
      rehydrateSession(r0, { db, roleConfig: cfg, idleSec: 1800, now: 1000 + 1801, traceId: randomUUID() }),
    ).rejects.toThrow()
    const rows = await db.refreshToken.findMany({ where: { principalId } })
    expect(rows).toHaveLength(1) // no successor row
    expect(rows[0]!.used).toBe(false)
  })

  it('an absolute-expired token 401s even while idle stays fresh', async () => {
    const principalId = await seedPrincipal('ACTIVE', 'admin')
    // issue@1000: absolute->4600 (inherited across rotations).
    const { refreshToken: r0 } = await issueRefreshFamily(principalId, 'cb', { db, idleSec: 1800, absoluteSec: 3600, now: 1000 })
    const { refreshToken: r1 } = await rehydrateSession(r0, { db, roleConfig: cfg, idleSec: 1800, now: 2500, traceId: randomUUID() })
    const { refreshToken: r2 } = await rehydrateSession(r1, { db, roleConfig: cfg, idleSec: 1800, now: 4000, traceId: randomUUID() })
    // now=4700 is within idle (5800) but past the family absolute bound (4600).
    await expect(
      rehydrateSession(r2, { db, roleConfig: cfg, idleSec: 1800, now: 4700, traceId: randomUUID() }),
    ).rejects.toThrow()
  })

  it('ORDERING PROPERTY: a deactivated principal 401s with NO refresh-ALLOW audit and NO rotation spent', async () => {
    const principalId = await seedPrincipal('DISABLED', 'admin')
    const { refreshToken: r0 } = await issueRefreshFamily(principalId, 'cb', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 })
    await expect(
      rehydrateSession(r0, { db, roleConfig: cfg, idleSec: 1800, now: 1100, traceId: randomUUID() }),
    ).rejects.toThrow()
    // No ALLOW audit was committed for the deactivated principal.
    const a = await audits(principalId)
    expect(a.filter((r) => r.decision === 'ALLOW')).toHaveLength(0)
    expect(a).toHaveLength(0) // nothing at all: the throw is before rotateRefresh
    // The rotation was NOT spent: the presented token is still unused, family intact.
    const rows = await db.refreshToken.findMany({ where: { principalId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.used).toBe(false)
    expect(rows[0]!.revoked).toBe(false)
  })

  it('an absent principal (family exists, principal row deleted) 401s with no audit and no rotation spent', async () => {
    const principalId = randomUUID() // no internal_principal row is ever created
    const { refreshToken: r0 } = await issueRefreshFamily(principalId, 'cb', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 })
    await expect(
      rehydrateSession(r0, { db, roleConfig: cfg, idleSec: 1800, now: 1100, traceId: randomUUID() }),
    ).rejects.toThrow()
    const a = await audits(principalId)
    expect(a).toHaveLength(0)
    const rows = await db.refreshToken.findMany({ where: { principalId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.used).toBe(false)
  })

  it('an unknown token 401s', async () => {
    await expect(
      rehydrateSession('not-a-real-token', { db, roleConfig: cfg, idleSec: 1800, now: 1100, traceId: randomUUID() }),
    ).rejects.toThrow()
  })
})
