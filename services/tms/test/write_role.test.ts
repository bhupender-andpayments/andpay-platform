import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { amendShipTo, activateAssignment } from '../src/assignment.js'
import type { DevicePort, ActivationCommand, ActivationResult } from '../src/device-port.js'

// Spec 10d Task 3: proves the tms_write role plus the assignment_scoped WITH
// CHECK gate actually bites once a non-superuser role is in force (S13), and
// that the two named Fork-E exceptions (amendShipTo, activateAssignment)
// resolve program_id SERVER-SIDE from the target row rather than trusting any
// caller input or leftover connection state (D99). Every connection here is
// the andpay CLUSTER SUPERUSER (POSTGRES_USER, infra/docker-compose.dev.yml),
// which bypasses RLS by superuser status alone; RLS only bites once SET LOCAL
// ROLE tms_write is in force inside the tx (current_user, not session_user,
// drives the RLS/superuser check). SET LOCAL is transaction-scoped, so each
// assertion expecting a WITH CHECK violation runs in its OWN transaction:
// once one statement in a Postgres transaction errors, the whole transaction
// aborts and every later statement fails closed with "current transaction is
// aborted", not the underlying RLS error.
const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

// A SEPARATE client dedicated to the UNSET-GUC block. Once any session has
// ever called set_config on a custom GUC (even under SET LOCAL, even if the
// transaction rolled back), Postgres registers that GUC name as a known
// session placeholder: later current_setting(...) calls on THAT SAME SESSION
// see '' instead of NULL, so a cast to uuid raises invalid-input rather than
// evaluating the WITH CHECK predicate to NULL/false. That is still a
// fail-closed rejection (no row is inserted either way), but it is not the
// true NULL-current_setting path this block proves, so it gets a connection
// that has never touched app.program_id at all.
const dbUnset = new PrismaClient({ datasourceUrl: url })

afterAll(async () => {
  await db.$disconnect()
  await dbUnset.$disconnect()
})

const RLS_VIOLATION = /row-level security|new row violates|WITH CHECK/i

function insertAssignmentSql(asgnUuid: string, programUuid: string, sourceEventId: string): string {
  return `
    INSERT INTO assignment (
      id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
      bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
      billable, demand_state, source_event_id, updated_at
    ) VALUES (
      '${asgnUuid}'::uuid, '${toUuid(newId('mrch'))}'::uuid, '${programUuid}'::uuid, '${toUuid(newId('tnnt'))}'::uuid,
      'X', 'X Pvt Ltd', '5411', 'HDFC', 'HDFC Bank', 'Addr', 'upi://x', 'x@hdfc-${asgnUuid}', true, 0, 0,
      true, 'received', '${sourceEventId}', now()
    )
  `
}

async function seedAssignment(programUuid: string): Promise<string> {
  const asgnUuid = toUuid(newId('asgn'))
  await db.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${programUuid}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Old Addr', 'upi://x', ${'x@hdfcbank-' + asgnUuid}, true, 0, 0,
    true, 'pooled-for-fulfillment', ${'seed|' + asgnUuid}, now()
  )`
  return fromUuid('asgn', asgnUuid)
}

class FakeDevicePort implements DevicePort {
  activate(cmd: ActivationCommand): Promise<ActivationResult> {
    void cmd
    return Promise.resolve({ activatedAt: '2026-07-28T00:00:00.000Z' })
  }
}

// A DB-level trigger, installed only for the duration of one test (files run
// serially, fileParallelism:false, so no other test file's writes can land
// while it exists). This is what makes the "spoofed GUC ignored" tests below
// NON-VACUOUS: the andpay connection is the cluster SUPERUSER, which bypasses
// RLS entirely regardless of role, so a WITH CHECK proof alone cannot tell a
// correctly role-scoped write from an owner-bypass write that happens to land
// on the right row anyway. This trigger independently asserts current_user at
// the moment of the real UPDATE issued by amendShipTo/activateAssignment: an
// unretrofitted implementation (running as owner) makes it RAISE and the call
// throws; only a correctly role-scoped call passes silently.
async function installCurrentUserGuard(): Promise<void> {
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test10d_assert_tms_write() RETURNS trigger AS $BODY$
    BEGIN
      IF current_user <> 'tms_write' THEN
        RAISE EXCEPTION 'spec 10d Task 3: expected current_user tms_write on assignment UPDATE, got %', current_user;
      END IF;
      RETURN NEW;
    END;
    $BODY$ LANGUAGE plpgsql;
  `)
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test10d_assert_tms_write_trg ON assignment`)
  await db.$executeRawUnsafe(`
    CREATE TRIGGER test10d_assert_tms_write_trg BEFORE UPDATE ON assignment
    FOR EACH ROW EXECUTE FUNCTION test10d_assert_tms_write()
  `)
}

async function uninstallCurrentUserGuard(): Promise<void> {
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test10d_assert_tms_write_trg ON assignment`)
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test10d_assert_tms_write()`)
}

describe('tms_write role and the assignment_scoped WITH CHECK gate (spec 10d Task 3)', () => {
  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE assignment, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
    )
  })

  it('current_user is tms_write once SET LOCAL ROLE is in force', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE tms_write`)
      const r = await tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`
      expect(r[0]!.current_user).toBe('tms_write')
    })
  })

  it('confirms tms_write is not owner and has no bypassrls', async () => {
    const r = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>>(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'tms_write'`,
    )
    expect(r).toHaveLength(1)
    expect(r[0]!.rolsuper).toBe(false)
    expect(r[0]!.rolbypassrls).toBe(false)
    expect(r[0]!.rolcanlogin).toBe(false)
  })

  describe('(a) representative M-pred writer: the createAssignmentFromEnrollment/ingestDamageRow INSERT shape', () => {
    it('WRONG-GUC: assignment INSERT (program_id = GUC) violates WITH CHECK when the GUC is a different program', async () => {
      const ownProgramId = toUuid(newId('prog'))
      const wrongProgramId = toUuid(newId('prog'))
      const asgnUuid = toUuid(newId('asgn'))
      await expect(
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE tms_write`)
          const u = await tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`
          expect(u[0]!.current_user).toBe('tms_write')
          await tx.$queryRaw`SELECT set_config('app.program_id', ${wrongProgramId}, true)`
          await tx.$executeRawUnsafe(insertAssignmentSql(asgnUuid, ownProgramId, `wrong-guc-${asgnUuid}`))
        }),
      ).rejects.toThrow(RLS_VIOLATION)
    })

    it('UNSET-GUC: assignment INSERT fails closed when current_setting(...) is NULL', async () => {
      const programId = toUuid(newId('prog'))
      const asgnUuid = toUuid(newId('asgn'))
      await expect(
        dbUnset.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE tms_write`)
          // No set_config call at all: current_setting('app.program_id', true) is NULL.
          await tx.$executeRawUnsafe(insertAssignmentSql(asgnUuid, programId, `unset-guc-${asgnUuid}`))
        }),
      ).rejects.toThrow(RLS_VIOLATION)
    })

    it('CORRECT: GUC = the row own program id, the assignment INSERT succeeds', async () => {
      const programId = toUuid(newId('prog'))
      const asgnUuid = toUuid(newId('asgn'))
      await db
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE tms_write`)
          await tx.$queryRaw`SELECT set_config('app.program_id', ${programId}, true)`
          await tx.$executeRawUnsafe(insertAssignmentSql(asgnUuid, programId, `correct-guc-${asgnUuid}`))
          const row = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM assignment WHERE id = ${asgnUuid}::uuid`
          expect(row).toHaveLength(1)
          // roll back: this test proves the write-gate, not persistence.
          throw new Error('rollback: test data cleanup')
        })
        .catch((e: Error) => {
          if (e.message !== 'rollback: test data cleanup') throw e
        })
    })
  })

  describe('(b) amendShipTo (named Fork-E exception, check 1/8): server-resolved program_id', () => {
    it('raw-SQL replica of its UPDATE: current_user is tms_write, and a wrong GUC violates WITH CHECK', async () => {
      const ownProgramId = toUuid(newId('prog'))
      const wrongProgramId = toUuid(newId('prog'))
      const asgnId = await seedAssignment(ownProgramId)
      const asgnUuid = toUuid(asgnId)

      await expect(
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE tms_write`)
          const u = await tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`
          expect(u[0]!.current_user).toBe('tms_write')
          await tx.$queryRaw`SELECT set_config('app.program_id', ${wrongProgramId}, true)`
          await tx.$executeRawUnsafe(
            `UPDATE assignment SET ship_to_address = 'Spoofed Addr', updated_at = now() WHERE id = '${asgnUuid}'::uuid`,
          )
        }),
      ).rejects.toThrow(RLS_VIOLATION)
    })

    it('a stale app.program_id left by a PRIOR (rolled-back) transaction on the same connection is NOT inherited: amendShipTo still resolves and uses the target own program (non-vacuous, D99)', async () => {
      const ownProgramId = toUuid(newId('prog'))
      const decoyProgramId = toUuid(newId('prog'))
      const asgnId = await seedAssignment(ownProgramId)

      // Poison the pool: a prior transaction on this SAME PrismaClient sets
      // app.program_id to a DIFFERENT program, then rolls back. SET LOCAL is
      // transaction-scoped, so this must NOT leak into amendShipTo's own
      // (later, separate) transaction. If amendShipTo ever forgot to resolve
      // and enter its OWN scope, it would either inherit nothing (fail closed,
      // since SET LOCAL always resets) or -- in a buggy alternate
      // implementation that read a caller-supplied/leftover value -- use the
      // wrong program and fail its own WITH CHECK. Either way this is a
      // non-vacuous proof: the ONLY way this assertion passes is if amendShipTo
      // resolved ownProgramId itself, fresh, from the assignment row.
      await db
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE tms_write`)
          await tx.$queryRaw`SELECT set_config('app.program_id', ${decoyProgramId}, true)`
          throw new Error('rollback: poison the GUC, never commit it')
        })
        .catch((e: Error) => {
          if (e.message !== 'rollback: poison the GUC, never commit it') throw e
        })

      // Non-vacuous against owner-bypass too (the andpay connection is the
      // cluster superuser): this trigger independently RAISES unless
      // current_user is tms_write at the moment of the real UPDATE, so an
      // unretrofitted (owner-bypass) amendShipTo would throw here instead of
      // silently succeeding via superuser RLS bypass.
      await installCurrentUserGuard()
      try {
        const r = await amendShipTo(db, asgnId, 'New Addr', 1, 'trace-1')
        expect(r.amended).toBe(true)
      } finally {
        await uninstallCurrentUserGuard()
      }

      const row = await db.$queryRaw<{ ship_to_address: string; program_id: string }[]>`
        SELECT ship_to_address, program_id FROM assignment WHERE id = ${toUuid(asgnId)}::uuid
      `
      expect(row[0]!.ship_to_address).toBe('New Addr')
      expect(row[0]!.program_id).toBe(ownProgramId)

      const ob = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
      expect(Number(ob[0]!.n)).toBe(1)
    })

    it('throws (fails closed) when the target assignment does not exist: never falls back to an unbound write', async () => {
      const bogusId = fromUuid('asgn', toUuid(newId('asgn')))
      await expect(amendShipTo(db, bogusId, 'New Addr', 1, 'trace-1')).rejects.toThrow(/not found/)
      const ob = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
      expect(Number(ob[0]!.n)).toBe(0)
    })
  })

  describe('(c) activateAssignment (named Fork-E exception, check 1/8): server-resolved program_id', () => {
    it('raw-SQL replica of its UPDATE: current_user is tms_write, and a wrong GUC violates WITH CHECK', async () => {
      const ownProgramId = toUuid(newId('prog'))
      const wrongProgramId = toUuid(newId('prog'))
      const asgnId = await seedAssignment(ownProgramId)
      const asgnUuid = toUuid(asgnId)

      await expect(
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE tms_write`)
          const u = await tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`
          expect(u[0]!.current_user).toBe('tms_write')
          await tx.$queryRaw`SELECT set_config('app.program_id', ${wrongProgramId}, true)`
          await tx.$executeRawUnsafe(
            `UPDATE assignment SET activated_at = now(), demand_state = 'activated', updated_at = now() WHERE id = '${asgnUuid}'::uuid`,
          )
        }),
      ).rejects.toThrow(RLS_VIOLATION)
    })

    it('a stale app.program_id left by a PRIOR (rolled-back) transaction on the same connection is NOT inherited: activateAssignment still resolves and uses the target own program (non-vacuous, D99)', async () => {
      const ownProgramId = toUuid(newId('prog'))
      const decoyProgramId = toUuid(newId('prog'))
      const asgnId = await seedAssignment(ownProgramId)

      await db
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE tms_write`)
          await tx.$queryRaw`SELECT set_config('app.program_id', ${decoyProgramId}, true)`
          throw new Error('rollback: poison the GUC, never commit it')
        })
        .catch((e: Error) => {
          if (e.message !== 'rollback: poison the GUC, never commit it') throw e
        })

      // Non-vacuous against owner-bypass too (see the amendShipTo test above
      // for why the trigger, not just the WITH CHECK, is required here).
      await installCurrentUserGuard()
      let r: { activated: boolean }
      try {
        r = await activateAssignment(db, asgnId, new FakeDevicePort(), 'device-1', 'trace-1')
      } finally {
        await uninstallCurrentUserGuard()
      }
      expect(r.activated).toBe(true)

      const row = await db.$queryRaw<{ demand_state: string; program_id: string; activated_at: Date | null }[]>`
        SELECT demand_state, program_id, activated_at FROM assignment WHERE id = ${toUuid(asgnId)}::uuid
      `
      expect(row[0]!.demand_state).toBe('activated')
      expect(row[0]!.program_id).toBe(ownProgramId)
      expect(row[0]!.activated_at).not.toBeNull()

      const ob = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
      expect(Number(ob[0]!.n)).toBe(1)
    })

    it('throws (fails closed) when the target assignment does not exist: never falls back to an unbound write', async () => {
      const bogusId = fromUuid('asgn', toUuid(newId('asgn')))
      await expect(activateAssignment(db, bogusId, new FakeDevicePort(), 'device-1', 'trace-1')).rejects.toThrow(/not found/)
      const ob = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
      expect(Number(ob[0]!.n)).toBe(0)
    })
  })

  describe('tms_relay (Fork B outbox-drain role, this migration)', () => {
    it('creates tms_relay with no superuser, no bypassrls, no login', async () => {
      const r = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>>(
        `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'tms_relay'`,
      )
      expect(r).toHaveLength(1)
      expect(r[0]!.rolsuper).toBe(false)
      expect(r[0]!.rolbypassrls).toBe(false)
      expect(r[0]!.rolcanlogin).toBe(false)
    })

    it('grants tms_relay SELECT, UPDATE on outbox only (no other tms table)', async () => {
      const grants = await db.$queryRawUnsafe<Array<{ table_name: string; privilege_type: string }>>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'tms_relay' AND table_schema = 'tms' ORDER BY table_name, privilege_type`,
      )
      expect(grants).toEqual([
        { table_name: 'outbox', privilege_type: 'SELECT' },
        { table_name: 'outbox', privilege_type: 'UPDATE' },
      ])
    })
  })

  describe('tms_write already has the grants every retrofitted writer needs (no landmine)', () => {
    it('has SELECT, INSERT, UPDATE, DELETE on every table the retrofitted writers touch', async () => {
      const tables = ['assignment', 'pending_row', 'merchant_projection', 'tenant_projection', 'quarantine_row', 'ingest_file', 'outbox', 'inbox']
      const inList = tables.map((t) => `'${t}'`).join(', ')
      const grants = await db.$queryRawUnsafe<Array<{ table_name: string; privilege_type: string }>>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'tms_write' AND table_schema = 'tms' AND table_name IN (${inList})`,
      )
      for (const t of tables) {
        for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          expect(grants.some((g) => g.table_name === t && g.privilege_type === priv), `${t} missing ${priv} for tms_write`).toBe(true)
        }
      }
    })
  })
})
