import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { verify as argonVerify } from '@node-rs/argon2'
import { newId } from '@andpay/ids'
import { PrismaClient, type AuthDb } from '../src/index.js'
import { enterWriteRole } from '../src/write-context.js'
import { emitAuthzAudit } from '../src/audit.js'
import { issueRefreshFamily, rotateRefresh } from '../src/refresh.js'
import * as vendorOperatorModule from '../src/vendor-operator.js'
import {
  provisionVendorOperator,
  lookupVendorOperatorByUsername,
  updateVendorOperatorPasswordHash,
  suspendVendorOperator,
  changeVendorPassword,
  adminResetVendorPassword,
  VendorOperatorDuplicateError,
} from '../src/vendor-operator.js'

// Spec 14a Task 4: vendor_operator STORE PRIMITIVES only (provision, lookup,
// the low-level password-hash-update primitive, suspend). The authenticated
// change-password + admin-reset FLOWS are Task 7 and are NOT built here.
const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
let db: AuthDb

beforeAll(() => {
  db = new PrismaClient({ datasourceUrl: url })
})
afterAll(async () => {
  // F-4: repeat the beforeEach cleanup at the END, or the LAST test's rows
  // outlive the whole gate. `beforeEach`-only cleanup always leaks exactly
  // that much, which is the F-9b shape, and `auth` is the one schema the
  // global teardown refuses to touch so nothing else will collect it.
  //
  // WIDER THAN THE beforeEach ON PURPOSE: this suite also mints `dupe-<uuid>`
  // (the duplicate-provision test), which `LIKE 'op-%'` never matched, so that
  // row survived even BETWEEN tests. Both prefixes are listed here.
  // authz_audit is hash-chained and is deliberately not touched.
  await db.$executeRawUnsafe(`DELETE FROM vendor_operator WHERE username LIKE 'op-%' OR username LIKE 'dupe-%'`)
  await db.$executeRawUnsafe(`DELETE FROM refresh_token WHERE principal_type = 'vendor_operator'`)
  await db.$executeRawUnsafe(`DELETE FROM mfa_enrollment WHERE principal_type = 'vendor_operator'`)
  await db.$disconnect()
})
beforeEach(async () => {
  // SCOPED to the usernames this suite mints, never the whole table. See the
  // same change in vendor-login.test.ts: the unfiltered TRUNCATE deleted
  // apps/vendor-auth-edge's beforeAll-seeded operator, whose login then failed
  // 401 in a different file, intermittently, purely on file order (F-1).
  // This suite only ever mints `op-<uuid>`, and no foreign key references
  // vendor_operator, so CASCADE was covering nothing.
  await db.$executeRawUnsafe(`DELETE FROM vendor_operator WHERE username LIKE 'op-%'`)
  await db.$executeRawUnsafe('TRUNCATE outbox')
})

function provisionInput(overrides: Partial<{ vndrId: string; username: string; password: string; createdByActor: string; traceId: string }> = {}) {
  return {
    vndrId: newId('vndr'),
    username: `op-${randomUUID()}`,
    password: 'correct horse battery staple',
    createdByActor: randomUUID(),
    traceId: 'trace-provision',
    ...overrides,
  }
}

describe('provisionVendorOperator (spec 14a task 4)', () => {
  it('creates a row readable back by lookup, with a peppered/argon hash stored and the raw password never present', async () => {
    const input = provisionInput()
    const { id } = await provisionVendorOperator(db, input)

    const row = await lookupVendorOperatorByUsername(db, input.username)
    expect(row).not.toBeNull()
    expect(row!.id).toBe(id)
    expect(row!.vndrId).toBe(input.vndrId)
    expect(row!.username).toBe(input.username)
    expect(row!.status).toBe('ACTIVE')

    // The stored hash is a real Argon2id hash of the raw password (verifiable),
    // and it is never byte-equal to the raw password itself.
    expect(row!.passwordHash).not.toBe(input.password)
    expect(await argonVerify(row!.passwordHash, input.password)).toBe(true)

    // The raw password is never a field on the returned result.
    expect(JSON.stringify({ id })).not.toContain(input.password)
  })

  it('rejects a duplicate (vndr_id, username) with a typed error, and leaves no duplicate operator', async () => {
    const input = provisionInput()
    await provisionVendorOperator(db, input)

    await expect(provisionVendorOperator(db, { ...input, password: 'a different password' })).rejects.toThrow(
      VendorOperatorDuplicateError,
    )

    const rows = await db.vendorOperator.findMany({ where: { vndrId: input.vndrId, username: input.username } })
    expect(rows).toHaveLength(1)
  })

  it('a current_user assertion INSIDE the provision transaction shows auth_write (SET LOCAL ROLE first)', async () => {
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_task4_assert_aw() RETURNS trigger AS $BODY$
      BEGIN
        IF current_user <> 'auth_write' THEN
          RAISE EXCEPTION 'spec 14a task 4: expected current_user auth_write on vendor_operator insert, got %', current_user;
        END IF;
        RETURN NEW;
      END;
      $BODY$ LANGUAGE plpgsql;
    `)
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_task4_aw_trg ON vendor_operator')
    await db.$executeRawUnsafe(
      'CREATE TRIGGER test_task4_aw_trg BEFORE INSERT ON vendor_operator FOR EACH ROW EXECUTE FUNCTION test_task4_assert_aw()',
    )
    try {
      // A correctly role-scoped provision passes silently (no RAISE EXCEPTION).
      await expect(provisionVendorOperator(db, provisionInput())).resolves.toBeDefined()
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_task4_aw_trg ON vendor_operator')
    }
  })

  it('co-commits the row and its 6e audit: an aborted tx leaves 0 row and 0 audit, a committed tx leaves 1 and 1 (mirrors the E1 rollback-vs-commit discrimination)', async () => {
    const id = randomUUID()
    const vndrId = newId('vndr')
    const username = `op-${randomUUID()}`
    const actor = randomUUID()

    // This composes the SAME building blocks provisionVendorOperator uses
    // internally (enterWriteRole, tx.vendorOperator.create, emitAuthzAudit)
    // and forces an abort AFTER both writes are issued but before commit, to
    // prove the row and the 6e audit commit or roll back TOGETHER (E1), not
    // independently.
    await db
      .$transaction(async (tx) => {
        await enterWriteRole(tx, 'auth_write')
        await tx.vendorOperator.create({
          data: { id, vndrId, username, passwordHash: 'irrelevant-for-this-probe', status: 'ACTIVE', createdByActor: actor },
        })
        await emitAuthzAudit(tx, {
          principalId: actor,
          cls: 7,
          operation: 'vendor_operator:provision',
          decision: 'ALLOW',
          outcome: 'provisioned',
          resourceIds: [id, vndrId],
          traceId: 'trace-abort-probe',
        })
        throw new Error('force rollback')
      })
      .catch(() => undefined)

    expect(await db.vendorOperator.count({ where: { id } })).toBe(0)
    expect(await db.outbox.count({ where: { eventType: 'authz.audit' } })).toBe(0)

    await db.$transaction(async (tx) => {
      await enterWriteRole(tx, 'auth_write')
      await tx.vendorOperator.create({
        data: { id, vndrId, username, passwordHash: 'irrelevant-for-this-probe', status: 'ACTIVE', createdByActor: actor },
      })
      await emitAuthzAudit(tx, {
        principalId: actor,
        cls: 7,
        operation: 'vendor_operator:provision',
        decision: 'ALLOW',
        outcome: 'provisioned',
        resourceIds: [id, vndrId],
        traceId: 'trace-commit-probe',
      })
    })

    expect(await db.vendorOperator.count({ where: { id } })).toBe(1)
    expect(await db.outbox.count({ where: { eventType: 'authz.audit' } })).toBe(1)
  })

  it('the real provisionVendorOperator call also co-commits: exactly 1 row and 1 authz.audit record', async () => {
    const input = provisionInput()
    const { id } = await provisionVendorOperator(db, input)

    expect(await db.vendorOperator.count({ where: { id } })).toBe(1)
    const audits = await db.outbox.findMany({ where: { eventType: 'authz.audit' } })
    const provisionAudit = audits.find((a) => JSON.stringify(a.payload).includes('"operation":"vendor_operator:provision"'))
    expect(provisionAudit).toBeDefined()
    const json = JSON.stringify(provisionAudit!.payload)
    expect(json.includes('"decision":"ALLOW"')).toBe(true)
    expect(json.includes(input.password)).toBe(false)
  })
})

describe('lookupVendorOperatorByUsername (spec 14a task 4)', () => {
  it('returns null when no operator matches the username', async () => {
    expect(await lookupVendorOperatorByUsername(db, `no-such-${randomUUID()}`)).toBeNull()
  })

  // Spec 14a audit finding (task 16, Bhupender's ruling): username must be
  // GLOBALLY unique, not just unique per-vendor, because lookup resolves by
  // username ALONE. This proves the lookup is unambiguous: exactly one row
  // comes back for a username that exists at exactly one vendor.
  it('returns the single unambiguous operator for a globally-unique username', async () => {
    const input = provisionInput()
    const { id } = await provisionVendorOperator(db, input)

    const row = await lookupVendorOperatorByUsername(db, input.username)
    expect(row).not.toBeNull()
    expect(row!.id).toBe(id)
    expect(row!.vndrId).toBe(input.vndrId)
  })
})

describe('username global uniqueness (spec 14a task 16, Bhupender ruling)', () => {
  it('rejects provisioning the SAME username at a DIFFERENT vendor with VendorOperatorDuplicateError', async () => {
    const username = `dupe-${randomUUID()}`
    const inputA = provisionInput({ username })
    await provisionVendorOperator(db, inputA)

    const inputB = provisionInput({ username })
    expect(inputB.vndrId).not.toBe(inputA.vndrId)

    await expect(provisionVendorOperator(db, inputB)).rejects.toThrow(VendorOperatorDuplicateError)

    // Only the first vendor's operator exists; no cross-vendor duplicate was created.
    const rows = await db.vendorOperator.findMany({ where: { username } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.vndrId).toBe(inputA.vndrId)
  })
})

describe('updateVendorOperatorPasswordHash (spec 14a task 4, low-level primitive for Task 7)', () => {
  it('updates the stored hash under auth_write, inside the caller-supplied tx', async () => {
    const input = provisionInput()
    const { id } = await provisionVendorOperator(db, input)
    const newHash = 'new-hash-value-not-a-real-argon-output'

    await db.$transaction(async (tx) => {
      await enterWriteRole(tx, 'auth_write')
      await updateVendorOperatorPasswordHash(tx, { id, newHash })
    })

    const row = await lookupVendorOperatorByUsername(db, input.username)
    expect(row!.passwordHash).toBe(newHash)
  })
})

describe('suspendVendorOperator (spec 14a task 4)', () => {
  it('flips status to SUSPENDED and co-commits its own 6e audit', async () => {
    const input = provisionInput()
    const { id } = await provisionVendorOperator(db, input)
    const actor = randomUUID()

    await suspendVendorOperator(db, { id, actor, traceId: 'trace-suspend' })

    const row = await lookupVendorOperatorByUsername(db, input.username)
    expect(row!.status).toBe('SUSPENDED')

    const audits = await db.outbox.findMany({ where: { eventType: 'authz.audit' } })
    const suspendAudit = audits.find((a) => JSON.stringify(a.payload).includes('"operation":"vendor_operator:suspend"'))
    expect(suspendAudit).toBeDefined()
    expect(JSON.stringify(suspendAudit!.payload).includes(id)).toBe(true)
  })

  it('a current_user assertion INSIDE the suspend transaction shows auth_write (SET LOCAL ROLE first)', async () => {
    const input = provisionInput()
    const { id } = await provisionVendorOperator(db, input)
    const actor = randomUUID()

    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_task4_assert_aw_update() RETURNS trigger AS $BODY$
      BEGIN
        IF current_user <> 'auth_write' THEN
          RAISE EXCEPTION 'spec 14a task 4: expected current_user auth_write on vendor_operator update, got %', current_user;
        END IF;
        RETURN NEW;
      END;
      $BODY$ LANGUAGE plpgsql;
    `)
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_task4_aw_update_trg ON vendor_operator')
    await db.$executeRawUnsafe(
      'CREATE TRIGGER test_task4_aw_update_trg BEFORE UPDATE ON vendor_operator FOR EACH ROW EXECUTE FUNCTION test_task4_assert_aw_update()',
    )
    try {
      // A correctly role-scoped suspend passes silently (no RAISE EXCEPTION).
      await expect(suspendVendorOperator(db, { id, actor, traceId: 'trace-suspend-aw' })).resolves.toBeUndefined()
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_task4_aw_update_trg ON vendor_operator')
    }
  })
})

// Spec 14a Task 7: the authenticated change-password and admin-reset FLOWS
// built on Task 4's primitives. No self-service email/SMS reset path exists.
describe('changeVendorPassword (spec 14a task 7)', () => {
  it('with the CORRECT current password: updates the hash (new works, old fails), revokes the operator other vendor refresh families, and co-commits ONE 6e ALLOW password-change', async () => {
    const input = provisionInput()
    const { id } = await provisionVendorOperator(db, input)

    // A pre-existing vendor refresh family for this operator (hygiene revoke target).
    const { refreshToken: priorRefresh } = await issueRefreshFamily(id, 'client-A', { db, idleSec: 1800, absoluteSec: 28800 }, 'vendor_operator')

    await changeVendorPassword(
      db,
      { operatorId: id, currentPassword: input.password, newPassword: 'a whole new correct horse', traceId: 'trace-change' },
    )

    const row = await lookupVendorOperatorByUsername(db, input.username)
    expect(await argonVerify(row!.passwordHash, 'a whole new correct horse')).toBe(true)
    expect(await argonVerify(row!.passwordHash, input.password)).toBe(false)

    // The prior vendor refresh family is now revoked: rotating it fails.
    await expect(rotateRefresh(priorRefresh, { db, idleSec: 1800, principalType: 'vendor_operator' })).rejects.toThrow()

    const audits = await db.outbox.findMany({ where: { eventType: 'authz.audit' } })
    const allow = audits.find(
      (a) => JSON.stringify(a.payload).includes('"operation":"password-change"') && JSON.stringify(a.payload).includes('"decision":"ALLOW"'),
    )
    expect(allow).toBeDefined()
    const json = JSON.stringify(allow!.payload)
    expect(json.includes(id)).toBe(true)
    expect(json.includes('a whole new correct horse')).toBe(false)
    expect(json.includes(input.password)).toBe(false)
  })

  it('with a WRONG current password: DENIES, is durable BEFORE the throw, the hash stays unchanged, and no family is revoked', async () => {
    const input = provisionInput()
    const { id } = await provisionVendorOperator(db, input)
    const { refreshToken: priorRefresh } = await issueRefreshFamily(id, 'client-A', { db, idleSec: 1800, absoluteSec: 28800 }, 'vendor_operator')

    const before = await lookupVendorOperatorByUsername(db, input.username)

    await expect(
      changeVendorPassword(db, { operatorId: id, currentPassword: 'totally wrong password', newPassword: 'irrelevant new password', traceId: 'trace-deny' }),
    ).rejects.toThrow()

    const after = await lookupVendorOperatorByUsername(db, input.username)
    expect(after!.passwordHash).toBe(before!.passwordHash)

    // The prior family is untouched: rotation still works.
    const rotated = await rotateRefresh(priorRefresh, { db, idleSec: 1800, principalType: 'vendor_operator' })
    expect(rotated.refreshToken).toBeTruthy()

    const audits = await db.outbox.findMany({ where: { eventType: 'authz.audit' } })
    const deny = audits.find(
      (a) => JSON.stringify(a.payload).includes('"operation":"password-change"') && JSON.stringify(a.payload).includes('"decision":"DENY"'),
    )
    expect(deny).toBeDefined()
    expect(JSON.stringify(deny!.payload).includes('totally wrong password')).toBe(false)
  })
})

describe('adminResetVendorPassword (spec 14a task 7)', () => {
  it('updates the hash with NO current-password check, revokes vendor refresh families, and co-commits ONE 6e ALLOW admin-reset with the class-3 actor', async () => {
    const input = provisionInput()
    const { id } = await provisionVendorOperator(db, input)
    const { refreshToken: priorRefresh } = await issueRefreshFamily(id, 'client-A', { db, idleSec: 1800, absoluteSec: 28800 }, 'vendor_operator')
    const actor = randomUUID()

    await adminResetVendorPassword(db, { operatorId: id, newPassword: 'admin chosen replacement', actor, traceId: 'trace-admin-reset' })

    const row = await lookupVendorOperatorByUsername(db, input.username)
    expect(await argonVerify(row!.passwordHash, 'admin chosen replacement')).toBe(true)
    expect(await argonVerify(row!.passwordHash, input.password)).toBe(false)

    await expect(rotateRefresh(priorRefresh, { db, idleSec: 1800, principalType: 'vendor_operator' })).rejects.toThrow()

    const audits = await db.outbox.findMany({ where: { eventType: 'authz.audit' } })
    const allow = audits.find(
      (a) => JSON.stringify(a.payload).includes('"operation":"admin-reset"') && JSON.stringify(a.payload).includes('"decision":"ALLOW"'),
    )
    expect(allow).toBeDefined()
    const json = JSON.stringify(allow!.payload)
    expect(json.includes(actor)).toBe(true)
    expect(json.includes('admin chosen replacement')).toBe(false)
  })
})

describe('no self-service reset path (spec 14a task 7)', () => {
  it('exports no self-service email/SMS reset function from vendor-operator.ts', () => {
    const exportNames = Object.keys(vendorOperatorModule)
    for (const name of exportNames) {
      expect(name.toLowerCase()).not.toMatch(/selfservice|self_service|emailreset|smsreset|resetlink|resettoken/)
    }
  })
})
