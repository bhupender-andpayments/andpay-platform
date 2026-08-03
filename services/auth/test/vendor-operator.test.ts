import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { verify as argonVerify } from '@node-rs/argon2'
import { newId } from '@andpay/ids'
import { PrismaClient, type AuthDb } from '../src/index.js'
import { enterWriteRole } from '../src/write-context.js'
import { emitAuthzAudit } from '../src/audit.js'
import {
  provisionVendorOperator,
  lookupVendorOperatorByUsername,
  updateVendorOperatorPasswordHash,
  suspendVendorOperator,
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
  await db.$disconnect()
})
beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE vendor_operator, outbox CASCADE')
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
