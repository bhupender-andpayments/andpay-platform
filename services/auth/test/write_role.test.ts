import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { issueVendorCredential, revokeVendorCredential } from '../src/credentials.js'
import { addToDenylist } from '../src/denylist.js'
import { issueRefreshFamily, rotateRefresh } from '../src/refresh.js'
import { LocalPepperAdapter } from '../src/ports/pepper.js'
import type { LeanClaim } from '@andpay/authz'

// Spec 10d Task 6: proves the auth_write role for the Auth context. Auth has
// ZERO program-scoped tables (spec 04 field 9): every auth table is
// WITH CHECK (true), so there is no self-referential program predicate to
// prove here (unlike identity/tms/fulfillment's *_scoped WITH CHECK gates).
// This is M-ROLE ONLY. Every connection here is the andpay CLUSTER SUPERUSER
// (POSTGRES_USER, infra/docker-compose.dev.yml), which bypasses RLS and
// schema-privilege checks by superuser status alone; the role boundary only
// bites once SET LOCAL ROLE auth_write is in force inside the tx
// (current_user, not session_user, drives the privilege check). SET LOCAL is
// transaction-scoped.
const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
const db = new PrismaClient({ datasourceUrl: url })

afterAll(async () => {
  await db.$disconnect()
})

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE refresh_token, vendor_credential, denylist, outbox CASCADE')
})

// A DB-level BEFORE trigger, installed only for the duration of one test
// (this file runs its statements serially within each test), asserting
// current_user at the moment of the REAL write issued by the writer under
// test. This is what makes the writer proofs NON-VACUOUS: the andpay
// connection is the cluster superuser, which bypasses RLS/grants entirely, so
// a happy-path proof alone cannot tell a correctly role-scoped write from an
// owner-bypass write that lands on the right row anyway. An unretrofitted
// (owner) writer makes this RAISE and the call throws; only a correctly
// role-scoped call passes silently.
async function installGuard(table: string, when: string): Promise<void> {
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test10d_assert_aw() RETURNS trigger AS $BODY$
    BEGIN
      IF current_user <> 'auth_write' THEN
        RAISE EXCEPTION 'spec 10d Task 6: expected current_user auth_write on %, got %', TG_TABLE_NAME, current_user;
      END IF;
      RETURN NEW;
    END;
    $BODY$ LANGUAGE plpgsql;
  `)
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test10d_aw_trg_${table} ON ${table}`)
  await db.$executeRawUnsafe(
    `CREATE TRIGGER test10d_aw_trg_${table} ${when} ON ${table} FOR EACH ROW EXECUTE FUNCTION test10d_assert_aw()`,
  )
}
async function dropGuard(table: string): Promise<void> {
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test10d_aw_trg_${table} ON ${table}`)
}

const pepperPort = new LocalPepperAdapter('dev-pepper-not-a-real-secret')

// The class-3 internal operator claim, fresh AAL2 step-up (6b), mirrors
// test/vendor-credential.test.ts's opsClaim so issueVendorCredential's
// requireStepUp guard is satisfied.
function opsClaim(authTime: number): LeanClaim {
  return {
    iss: 'andpay-auth', sub: randomUUID(), aud: 'andpay:internal-admin', iat: authTime, exp: authTime + 600, nbf: authTime,
    jti: 'j', cls: 3, mode: 'live', scope: {}, psr: 'role:ops', epoch: 1, acr: 'AAL2', amr: ['pwd', 'otp'], auth_time: authTime,
  }
}

describe('auth_write role sanity (spec 10d Task 6)', () => {
  it('current_user is auth_write once SET LOCAL ROLE is in force', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE auth_write`)
      const r = await tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`
      expect(r[0]!.current_user).toBe('auth_write')
    })
  })

  it('auth_write is not owner, has no bypassrls, no login', async () => {
    const r = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>>(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'auth_write'`,
    )
    expect(r).toHaveLength(1)
    expect(r[0]!.rolsuper).toBe(false)
    expect(r[0]!.rolbypassrls).toBe(false)
    expect(r[0]!.rolcanlogin).toBe(false)
  })

  it('auth_write has USAGE on schema auth only (no other schema)', async () => {
    const own = await db.$queryRaw<{ ok: boolean }[]>`SELECT has_schema_privilege('auth_write', 'auth', 'USAGE') AS ok`
    expect(own[0]!.ok).toBe(true)
    for (const schema of ['identity', 'tms', 'fulfillment', 'orchestrator']) {
      const r = await db.$queryRawUnsafe<{ ok: boolean }[]>(
        `SELECT has_schema_privilege('auth_write', '${schema}', 'USAGE') AS ok`,
      )
      expect(r[0]!.ok, `auth_write must NOT have USAGE on ${schema}`).toBe(false)
    }
  })
})

describe('NO program_id predicate anywhere in auth (spec 04 field 9): every WITH CHECK is true', () => {
  it('all pg_policies rows for schema auth have with_check = true (or no program_id qualifier)', async () => {
    const rows = await db.$queryRaw<Array<{ tablename: string; with_check: string | null; qual: string | null }>>`
      SELECT tablename, with_check, qual FROM pg_policies WHERE schemaname = 'auth'
    `
    for (const row of rows) {
      expect(row.with_check === null || row.with_check === 'true', `policy on ${row.tablename} has non-true WITH CHECK: ${row.with_check}`).toBe(true)
      expect((row.qual ?? '').includes('program_id'), `policy on ${row.tablename} references program_id`).toBe(false)
      expect((row.with_check ?? '').includes('program_id'), `policy on ${row.tablename} references program_id`).toBe(false)
    }
  })
})

describe('a cross-schema write under auth_write is DENIED by Postgres (proves the M-role boundary)', () => {
  it('an INSERT into identity.tenant under auth_write fails: no USAGE on schema identity', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE auth_write`)
        await tx.$executeRawUnsafe(
          `INSERT INTO identity.tenant (id, display_name, bank_reference_code, status)
           VALUES ('${toUuid(newId('tnnt'))}'::uuid, 'X', 'BREF-WR-XSCHEMA', 'ACTIVE')`,
        )
      }),
    ).rejects.toThrow(/permission denied/i)
  })
})

describe('internal_principal under auth_write: SELECT ok, INSERT/UPDATE denied (login read-only, spec 04)', () => {
  it('SELECT succeeds', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE auth_write`)
      await tx.$executeRawUnsafe(`SELECT * FROM internal_principal LIMIT 1`)
    })
  })

  it('INSERT is denied (no write grant)', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE auth_write`)
        await tx.$executeRawUnsafe(
          `INSERT INTO internal_principal (id, login_handle, password_hash, role, status, updated_at)
           VALUES ('${randomUUID()}'::uuid, 'wr-handle-${randomUUID()}', 'x', 'ops_agent', 'ACTIVE', now())`,
        )
      }),
    ).rejects.toThrow(/permission denied/i)
  })

  it('UPDATE is denied (no write grant)', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE auth_write`)
        await tx.$executeRawUnsafe(`UPDATE internal_principal SET status = 'ACTIVE' WHERE false`)
      }),
    ).rejects.toThrow(/permission denied/i)
  })
})

describe('live writers run under auth_write (non-vacuous, current_user trigger)', () => {
  it('issueVendorCredential writes vendor_credential as auth_write', async () => {
    const vndrId = fromUuid('vndr', toUuid(newId('vndr')))
    const operatorId = randomUUID()
    await installGuard('vendor_credential', 'BEFORE INSERT')
    try {
      const res = await issueVendorCredential(
        { vndrId, workQueue: 'wq-wr', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: `idem-wr-${randomUUID()}` },
        { operatorId, claim: opsClaim(1000) },
        { db, pepper: pepperPort, traceId: 'trace-wr', now: 1000 },
      )
      expect(res.reused).toBe(false)
    } finally {
      await dropGuard('vendor_credential')
    }
  })

  it('revokeVendorCredential writes vendor_credential as auth_write', async () => {
    const vndrId = fromUuid('vndr', toUuid(newId('vndr')))
    const operatorId = randomUUID()
    const res = await issueVendorCredential(
      { vndrId, workQueue: 'wq-wr', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: `idem-wr-${randomUUID()}` },
      { operatorId, claim: opsClaim(1000) },
      { db, pepper: pepperPort, traceId: 'trace-wr', now: 1000 },
    )
    await installGuard('vendor_credential', 'BEFORE UPDATE')
    try {
      await revokeVendorCredential(res.apiId, { db, traceId: 'trace-wr', now: 2000 })
    } finally {
      await dropGuard('vendor_credential')
    }
  })

  it('addToDenylist writes denylist as auth_write', async () => {
    await installGuard('denylist', 'BEFORE INSERT')
    try {
      await addToDenylist(db, `entry-wr-${randomUUID()}`, 'test')
    } finally {
      await dropGuard('denylist')
    }
  })

  it('issueRefreshFamily writes refresh_token as auth_write (NAMED Fork-E exception: tx-wrapped, was non-transactional)', async () => {
    await installGuard('refresh_token', 'BEFORE INSERT')
    try {
      const res = await issueRefreshFamily(randomUUID(), 'client-wr', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 })
      expect(res.refreshToken).toBeTruthy()
    } finally {
      await dropGuard('refresh_token')
    }
  })

  it('rotateRefresh writes the successor refresh_token row as auth_write (the in-tx site)', async () => {
    const { refreshToken: r0 } = await issueRefreshFamily(randomUUID(), 'client-wr', { db, idleSec: 1800, absoluteSec: 28800, now: 2000 })
    await installGuard('refresh_token', 'BEFORE UPDATE')
    try {
      const res = await rotateRefresh(r0, { db, idleSec: 1800, now: 2100 })
      expect(res.refreshToken).not.toBe(r0)
    } finally {
      await dropGuard('refresh_token')
    }
  })
})

// issueRefreshFamily BEHAVIORAL: the tx-wrap must preserve refresh-family
// semantics exactly (spec 04 check 3): reuse of a rotated token still revokes
// the whole family; idle and absolute bounds still enforced. Mirrors
// test/refresh-family.test.ts, run again here to prove the tx-wrap changed no
// observable behavior.
describe('issueRefreshFamily tx-wrap behavioral proof: refresh-family semantics preserved (spec 04 check 3)', () => {
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
    await expect(rotateRefresh(r0, { db, idleSec: 1800, now: 1200 })).rejects.toThrow()
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
    const { refreshToken: r0 } = await issueRefreshFamily(principalId, 'client-A', { db, idleSec: 1800, absoluteSec: 3600, now: 1000 })
    const { refreshToken: r1 } = await rotateRefresh(r0, { db, idleSec: 1800, now: 2500 })
    const { refreshToken: r2 } = await rotateRefresh(r1, { db, idleSec: 1800, now: 4000 })
    await expect(rotateRefresh(r2, { db, idleSec: 1800, now: 4700 })).rejects.toThrow()
  })
})
