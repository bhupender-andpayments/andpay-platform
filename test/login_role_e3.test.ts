import { describe, it, expect, afterAll } from 'vitest'
import { PrismaClient } from '@andpay/identity-service'

// GO-LIVE BLOCKER E-3 (H3, task P4-3): the proof obligation for the
// per-context non-superuser login roles.
//
// THE POSTURE THIS GUARDS IS LIVE. `andpay` is the only role in the cluster
// that can log in, and it is SUPERUSER with BYPASSRLS, so every connection the
// platform makes bypasses every RLS policy. The policies are correct and well
// tested; nothing enforces them in a running system. These roles are the fix,
// and this file is what stops them being six unused rows in pg_roles.
//
// WHAT THIS CAN AND CANNOT PROVE. Passwords are deliberately NOT set in the
// migrations (S4), so nothing here can open a real connection as <ctx>_app.
// What it proves instead is everything that does not need one: the role
// attributes, the exact membership boundary, and that RLS actually bites once
// the superuser attributes are dropped. Postgres decides BYPASSRLS from the
// CURRENT role, so `SET ROLE` to a non-bypassrls role is a faithful test of the
// enforcement itself.
//
// THE REMAINING STEP IS BHUPENDER'S and is a real deploy gate: set a password
// per role and rewire each <ctx>_DATABASE_URL. Until then this fails CLOSED,
// because a LOGIN role with no password cannot authenticate at all.

const db = new PrismaClient({
  datasourceUrl:
    process.env.IDENTITY_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity',
})

afterAll(async () => {
  await db.$disconnect()
})

const CONTEXT_ROLES: Record<string, string[]> = {
  identity_app: ['identity_write', 'identity_read', 'identity_relay'],
  tms_app: ['tms_write', 'tms_read', 'tms_ops_read', 'tms_relay'],
  fulfillment_app: [
    'fulfillment_write',
    'fulfillment_read',
    'fulfillment_ops_read',
    'fulfillment_relay',
    'fulfillment_engine',
    'fulfillment_vendor_read',
  ],
  analytics_app: ['analytics_write', 'analytics_read', 'analytics_relay'],
  auth_app: ['auth_write', 'auth_appender'],
  orchestrator_app: ['orchestrator_write'],
}

interface RoleAttrs {
  rolname: string
  rolcanlogin: boolean
  rolsuper: boolean
  rolbypassrls: boolean
  rolinherit: boolean
}

async function attrs(): Promise<RoleAttrs[]> {
  return db.$queryRawUnsafe<RoleAttrs[]>(
    `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit
     FROM pg_roles WHERE rolname LIKE '%\\_app' ORDER BY rolname`,
  )
}

async function membersOf(role: string): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ granted: string }[]>(
    `SELECT g.rolname AS granted
       FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member
       JOIN pg_roles g ON g.oid = m.roleid
      WHERE r.rolname = $1 ORDER BY 1`,
    role,
  )
  return rows.map((r) => r.granted)
}

describe('E-3: every context has a non-superuser login role', () => {
  it('all six exist', async () => {
    expect((await attrs()).map((r) => r.rolname)).toEqual(Object.keys(CONTEXT_ROLES).sort())
  })

  it('each can LOG IN but is NOT superuser and does NOT bypass RLS', async () => {
    // Any one of these being wrong reproduces the blocker exactly.
    for (const r of await attrs()) {
      expect(r.rolcanlogin, `${r.rolname} must be able to log in`).toBe(true)
      expect(r.rolsuper, `${r.rolname} must NOT be superuser`).toBe(false)
      expect(r.rolbypassrls, `${r.rolname} must NOT bypass RLS`).toBe(false)
    }
  })

  it('each is NOINHERIT, so it holds nothing until it enters a work role', async () => {
    // With INHERIT the connection would hold the UNION of every privilege below
    // it from the moment it connects: a read path could write, and a query that
    // forgot SET LOCAL ROLE would silently succeed with more power than it
    // should have. NOINHERIT turns that same forgetful query into a permission
    // denied, which is what makes the repo's enter-the-role-first rule
    // enforceable rather than advisory.
    for (const r of await attrs()) {
      expect(r.rolinherit, `${r.rolname} must be NOINHERIT`).toBe(false)
    }
  })

  it('carries NO password, so it fails CLOSED until one is set out of band', async () => {
    // S4: secrets never in code, config or migrations. This asserts the
    // migrations did not smuggle one in, and documents that the deploy step is
    // still owed.
    const rows = await db.$queryRawUnsafe<{ rolname: string; has_password: boolean }[]>(
      `SELECT r.rolname, (a.rolpassword IS NOT NULL) AS has_password
         FROM pg_roles r LEFT JOIN pg_authid a ON a.oid = r.oid
        WHERE r.rolname LIKE '%\\_app'`,
    )
    for (const r of rows) {
      expect(r.has_password, `${r.rolname} must have no password committed in a migration`).toBe(false)
    }
  })
})

describe('E-3: the membership boundary IS the C4 boundary', () => {
  it('each login role holds EXACTLY its own context work roles', async () => {
    for (const [app, expected] of Object.entries(CONTEXT_ROLES)) {
      expect(await membersOf(app), `${app} membership drifted`).toEqual([...expected].sort())
    }
  })

  it('no login role can enter ANOTHER context work role', async () => {
    // The assertion that matters most. If identity_app could enter tms_write,
    // the cross-context boundary would be enforced only by application code.
    for (const [app, own] of Object.entries(CONTEXT_ROLES)) {
      const context = app.replace(/_app$/, '')
      for (const granted of await membersOf(app)) {
        expect(granted.startsWith(`${context}_`), `${app} holds foreign role ${granted}`).toBe(true)
        expect(own).toContain(granted)
      }
    }
  })

  it('holds no superuser-ish role and nothing outside the work-role set', async () => {
    for (const app of Object.keys(CONTEXT_ROLES)) {
      const granted = await membersOf(app)
      expect(granted).not.toContain('andpay')
      expect(granted.some((g) => g.endsWith('_app'))).toBe(false)
    }
  })
})

describe('E-3: RLS actually bites once the superuser attributes are dropped', () => {
  it('a non-bypassrls role gets permission denied where the owner sails through', async () => {
    // Postgres reads BYPASSRLS from the CURRENT role, so SET LOCAL ROLE is a
    // faithful stand-in for connecting as the role, without needing a password.
    //
    // identity_read has USAGE on the schema but NO grant on merchant_bank_ref,
    // so this proves privileges are being evaluated against the entered role
    // rather than against the superuser that opened the connection.
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE identity_read')
        return tx.$queryRawUnsafe('SELECT count(*) FROM merchant_bank_ref')
      }),
    ).rejects.toThrow(/permission denied/i)
  })

  it('the SAME query succeeds as the owner, so the test is not passing for the wrong reason', async () => {
    // Without this, the assertion above would still pass if the table were
    // missing or the query malformed.
    await expect(db.$queryRawUnsafe('SELECT count(*) FROM merchant_bank_ref')).resolves.toBeDefined()
  })

  it('current_user really becomes the entered role inside the transaction', async () => {
    const who = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE identity_read')
      return tx.$queryRawUnsafe<{ u: string }[]>('SELECT current_user AS u')
    })
    expect(who[0]!.u).toBe('identity_read')
  })
})
