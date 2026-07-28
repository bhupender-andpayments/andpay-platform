import { describe, it, expect, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'

// Spec 10d Task 2: proves the identity_write role plus the program/enrollment
// self-referential WITH CHECK gates actually bite once a non-superuser role is
// in force (S13). Every connection here is the andpay CLUSTER SUPERUSER
// (POSTGRES_USER, infra/docker-compose.dev.yml), which bypasses RLS by
// superuser status alone. RLS only bites once SET LOCAL ROLE identity_write is
// in force inside the tx (current_user, not session_user, drives the
// RLS/superuser check); SET LOCAL is transaction-scoped, so each assertion that
// expects a WITH CHECK violation runs in its OWN transaction. Once one
// statement in a Postgres transaction errors, the whole transaction is aborted
// and every later statement in that SAME transaction fails closed with
// "current transaction is aborted", not the underlying RLS error, so a second
// failing INSERT can never share a transaction with the first.
const url =
  process.env.IDENTITY_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity'
const db = new PrismaClient({ datasourceUrl: url })

// A SEPARATE client (its own connection pool) dedicated to the UNSET-GUC
// block below. Once any session has ever called set_config on a custom GUC
// (even under SET LOCAL, even if the transaction rolled back), Postgres
// registers that GUC name as a known session placeholder: later
// current_setting(...) calls on THAT SAME SESSION see '' instead of NULL, so
// a cast to uuid raises invalid-input rather than evaluating the WITH CHECK
// predicate to NULL/false. That is still a fail-closed rejection (no row is
// inserted either way), but it is not the true NULL-current_setting path the
// brief asks this block to prove, so this block gets a connection that has
// never touched app.program_id at all.
const dbUnset = new PrismaClient({ datasourceUrl: url })

afterAll(async () => {
  await db.$disconnect()
  await dbUnset.$disconnect()
})

const RLS_VIOLATION = /row-level security|new row violates|WITH CHECK/i

describe('identity_write role and the program/enrollment self-referential WITH CHECK (spec 10d check 6)', () => {
  it('current_user is identity_write once SET LOCAL ROLE is in force', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE identity_write`)
      const r = await tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`
      expect(r[0]!.current_user).toBe('identity_write')
    })
  })

  describe('(a) WRONG-GUC: app.program_id set to a DIFFERENT uuid rejects the program and enrollment INSERTs', () => {
    const tenantId = toUuid(newId('tnnt'))
    const merchantId = toUuid(newId('mrch'))
    const ownProgramId = toUuid(newId('prog'))
    const wrongProgramId = toUuid(newId('prog'))

    it('program INSERT (id = GUC) violates WITH CHECK when the GUC is a different program', async () => {
      await expect(
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE identity_write`)
          await tx.$queryRaw`SELECT set_config('app.program_id', ${wrongProgramId}, true)`
          await tx.$executeRawUnsafe(
            `INSERT INTO program (id, tenant_id, product_type, status)
             VALUES ('${ownProgramId}'::uuid, '${tenantId}'::uuid, 'soundbox_dispatch', 'ACTIVE')`,
          )
        }),
      ).rejects.toThrow(RLS_VIOLATION)
    })

    it('enrollment INSERT (program_id = GUC) violates WITH CHECK when the GUC is a different program', async () => {
      await expect(
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE identity_write`)
          await tx.$queryRaw`SELECT set_config('app.program_id', ${wrongProgramId}, true)`
          await tx.$executeRawUnsafe(
            `INSERT INTO enrollment (merchant_id, program_id, tenant_id, status, updated_at)
             VALUES ('${merchantId}'::uuid, '${ownProgramId}'::uuid, '${tenantId}'::uuid, 'ACTIVE', now())`,
          )
        }),
      ).rejects.toThrow(RLS_VIOLATION)
    })

    it('control: tenant INSERT (WITH CHECK true) succeeds unaffected, in the same wrong-GUC scope', async () => {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE identity_write`)
        await tx.$queryRaw`SELECT set_config('app.program_id', ${wrongProgramId}, true)`
        await tx.$executeRawUnsafe(
          `INSERT INTO tenant (id, display_name, bank_reference_code, status)
           VALUES ('${tenantId}'::uuid, 'X', 'BREF-WRONG-GUC-${tenantId}', 'ACTIVE')`,
        )
        const r = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tenant WHERE id = ${tenantId}::uuid`
        expect(r).toHaveLength(1)
        // roll back: this test proves the write-gate, not persistence.
        throw new Error('rollback: test data cleanup')
      }).catch((e: Error) => {
        if (e.message !== 'rollback: test data cleanup') throw e
      })
    })
  })

  describe('(b) UNSET-GUC: with NO set_config at all, the same INSERTs fail closed', () => {
    const tenantId = toUuid(newId('tnnt'))
    const merchantId = toUuid(newId('mrch'))
    const programId = toUuid(newId('prog'))

    it('program INSERT (id = GUC) fails closed when current_setting(...) is NULL', async () => {
      // dbUnset: a connection that has never called set_config on
      // app.program_id, so current_setting('app.program_id', true) really is
      // the SQL NULL here, not a same-session leftover placeholder ''.
      await expect(
        dbUnset.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE identity_write`)
          // No set_config call at all: current_setting('app.program_id', true) is NULL.
          await tx.$executeRawUnsafe(
            `INSERT INTO program (id, tenant_id, product_type, status)
             VALUES ('${programId}'::uuid, '${tenantId}'::uuid, 'soundbox_dispatch', 'ACTIVE')`,
          )
        }),
      ).rejects.toThrow(RLS_VIOLATION)
    })

    it('enrollment INSERT (program_id = GUC) fails closed when current_setting(...) is NULL', async () => {
      await expect(
        dbUnset.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE identity_write`)
          // No set_config call at all: current_setting('app.program_id', true) is NULL.
          await tx.$executeRawUnsafe(
            `INSERT INTO enrollment (merchant_id, program_id, tenant_id, status, updated_at)
             VALUES ('${merchantId}'::uuid, '${programId}'::uuid, '${tenantId}'::uuid, 'ACTIVE', now())`,
          )
        }),
      ).rejects.toThrow(RLS_VIOLATION)
    })

    it('control: tenant INSERT (WITH CHECK true) succeeds unaffected, with no GUC set at all', async () => {
      await dbUnset.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE identity_write`)
        await tx.$executeRawUnsafe(
          `INSERT INTO tenant (id, display_name, bank_reference_code, status)
           VALUES ('${tenantId}'::uuid, 'X', 'BREF-UNSET-GUC-${tenantId}', 'ACTIVE')`,
        )
        const r = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tenant WHERE id = ${tenantId}::uuid`
        expect(r).toHaveLength(1)
        throw new Error('rollback: test data cleanup')
      }).catch((e: Error) => {
        if (e.message !== 'rollback: test data cleanup') throw e
      })
    })
  })

  it('(c) CORRECT: GUC = the row own program id, program/enrollment succeed and merchant/tenant (WITH CHECK true) coexist', async () => {
    const tenantId = toUuid(newId('tnnt'))
    const merchantId = toUuid(newId('mrch'))
    const programId = toUuid(newId('prog'))
    const bankRef = `BREF-CORRECT-${tenantId}`

    await db
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE identity_write`)
        await tx.$queryRaw`SELECT set_config('app.program_id', ${programId}, true)`

        await tx.$executeRawUnsafe(
          `INSERT INTO tenant (id, display_name, bank_reference_code, status)
           VALUES ('${tenantId}'::uuid, 'X', '${bankRef}', 'ACTIVE')`,
        )
        await tx.$executeRawUnsafe(
          `INSERT INTO merchant (id, display_name, legal_name, mcc, registered_address, activation_state, status, updated_at)
           VALUES ('${merchantId}'::uuid, 'X', 'X Pvt Ltd', '5411', 'addr', 'PENDING', 'ACTIVE', now())`,
        )
        await tx.$executeRawUnsafe(
          `INSERT INTO program (id, tenant_id, product_type, status)
           VALUES ('${programId}'::uuid, '${tenantId}'::uuid, 'soundbox_dispatch', 'ACTIVE')`,
        )
        await tx.$executeRawUnsafe(
          `INSERT INTO enrollment (merchant_id, program_id, tenant_id, status, updated_at)
           VALUES ('${merchantId}'::uuid, '${programId}'::uuid, '${tenantId}'::uuid, 'ACTIVE', now())`,
        )

        const tenantRow = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tenant WHERE id = ${tenantId}::uuid`
        const merchantRow = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM merchant WHERE id = ${merchantId}::uuid`
        const programRow = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM program WHERE id = ${programId}::uuid`
        const enrollmentRow = await tx.$queryRaw<{ program_id: string }[]>`
          SELECT program_id FROM enrollment WHERE program_id = ${programId}::uuid AND merchant_id = ${merchantId}::uuid
        `
        expect(tenantRow).toHaveLength(1)
        expect(merchantRow).toHaveLength(1)
        expect(programRow).toHaveLength(1)
        expect(enrollmentRow).toHaveLength(1)

        // roll back: this test proves the write-gate, not persistence.
        throw new Error('rollback: test data cleanup')
      })
      .catch((e: Error) => {
        if (e.message !== 'rollback: test data cleanup') throw e
      })
  })

  it('confirms identity_write is not owner and has no bypassrls', async () => {
    const r = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>>(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'identity_write'`,
    )
    expect(r).toHaveLength(1)
    expect(r[0]!.rolsuper).toBe(false)
    expect(r[0]!.rolbypassrls).toBe(false)
    expect(r[0]!.rolcanlogin).toBe(false)
  })
})
