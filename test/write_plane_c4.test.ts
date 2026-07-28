import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  relayOnce,
  InMemoryPublisher,
  type OutboxClient,
} from '@andpay/outbox'
import { claimAndFireDueTimers, type EngineClient } from '@andpay/engine'
import { buildAuthzAuditEvent, type AuthzAuditRecord } from '@andpay/audit'
import { PrismaClient as FulfillmentClient } from '@andpay/fulfillment-service'
import { emitVendorAuthzAudit } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import {
  PrismaClient as AuthClient,
  consumeAuthzAudit,
  verifyAuthzChain,
  AUTHZ_AUDIT_CONSUMER,
  type AuthDb,
} from '@andpay/auth-service'

// The Step-1 inventory drives these. Each todo names the file(s) it will guard.
// Activated in Task 8 (no-owner guard + negatives), Task 5 (Fork B harness),
// Task 7 (orchestrator). Kept as todos here so main stays green (Global Constraints).
describe('10d write-plane C4 (cross-cutting)', () => {
  it.todo('check 1/4: every program-scoped writer references enterWriteScope; no bare owner writer [Task 8]')
  it.todo('check 4: no workload/infra role has BYPASSRLS or table ownership (pg_roles) [Task 8]')
  it.todo('check 4: cross-schema write under a context role denied by Postgres [Task 8]')
  it.todo('check 10: planted new-table write fails closed until GRANT added; no ALTER DEFAULT PRIVILEGES [Task 8]')
  it.todo('check 8: server-side program resolution ignores a spoofed program value [Task 8]')
  it.todo('check 7: dead orchestrator_write role, no handler, no src [Task 7]')
})

// -----------------------------------------------------------------------------
// check 3 (Task 5, LOAD-BEARING): the Fork B infra roles, harness-proven cross
// program against the EXISTING library functions. NO production daemon is built
// (ruling C2). Each library function owns its own transaction, so the role is
// proven by a thin $transaction wrapper that runs `SET LOCAL ROLE <infra>`
// BEFORE the library's claim/drain query and captures current_user inside that
// same transaction: the library's grants are exercised for real under the role.
// -----------------------------------------------------------------------------

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl =
  process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const authUrl =
  process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'

const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })
const authDb = new AuthClient({ datasourceUrl: authUrl })

const PROG_A = '11111111-1111-1111-1111-111111111111'
const PROG_B = '22222222-2222-2222-2222-222222222222'
const TENANT_A = '33333333-3333-3333-3333-333333333333'
const TENANT_B = '44444444-4444-4444-4444-444444444444'
const SAGA_A = '55555555-5555-5555-5555-555555555555'
const SAGA_B = '66666666-6666-6666-6666-666666666666'

interface Captured {
  user?: string
}

// The role harness. Wraps a client so the library's OWN internal transaction
// (relayOnce, claimAndFireDueTimers, consumeAuthzAudit each open their own)
// runs under SET LOCAL ROLE <role>. current_user is read inside that same tx,
// so the assertion proves the library's claim/drain ran under the infra role,
// not the owner. role is a compile-time constant here (never user input).
function roleClient<C extends { $transaction: unknown }>(
  db: C,
  role: string,
  captured: Captured,
): C {
  const base = db as unknown as {
    $transaction: <T>(fn: (tx: TxLike) => Promise<T>) => Promise<T>
  }
  return {
    $transaction: <T>(fn: (tx: TxLike) => Promise<T>): Promise<T> =>
      base.$transaction(async (tx: TxLike) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
        const who = await tx.$queryRawUnsafe<{ u: string }[]>(`SELECT current_user AS u`)
        captured.user = who[0]!.u
        return fn(tx)
      }),
  } as unknown as C
}

interface TxLike {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

function record(overrides: Partial<AuthzAuditRecord> = {}): AuthzAuditRecord {
  return {
    principalId: 'prn_task5',
    cls: 3,
    operation: 'login',
    decision: 'ALLOW',
    outcome: 'ok',
    traceId: 'trace-task5',
    ...overrides,
  }
}

beforeEach(async () => {
  await fulfillmentDb.$executeRawUnsafe(
    'TRUNCATE batch, batch_pool, saga_timer, saga_step, saga_instance, pending_pool_entry, outbox, inbox CASCADE',
  )
  await tmsDb.$executeRawUnsafe('TRUNCATE outbox, inbox CASCADE')
  await authDb.$executeRaw`DELETE FROM authz_audit`
  await authDb.$executeRawUnsafe(`DELETE FROM inbox WHERE consumer = '${AUTHZ_AUDIT_CONSUMER}'`)
})

afterAll(async () => {
  await fulfillmentDb.$disconnect()
  await tmsDb.$disconnect()
  await authDb.$disconnect()
})

describe('check 3: Fork B infra roles harness-proven cross-program (Task 5, no production daemons)', () => {
  // PROOF 1: the relay drains across programs under fulfillment_relay, with no
  // program predicate. The outbox is WITH CHECK(true) and NOT program-scoped;
  // the two seeded rows stand for facts of two different programs, and the point
  // is that fulfillment_relay drains BOTH with no program binding whatsoever.
  it('proof 1 RELAY: relayOnce under fulfillment_relay drains BOTH programs\' outbox rows (no program predicate); current_user = fulfillment_relay', async () => {
    await fulfillmentDb.$executeRaw`
      INSERT INTO outbox (aggregate_type, aggregate_id, event_type, partition_key, payload)
      VALUES ('batch', 'btch_a', 'fct.fulfillment.batch.v1', ${PROG_A}, ${'{"programId":"prog_a"}'}::jsonb)
    `
    await fulfillmentDb.$executeRaw`
      INSERT INTO outbox (aggregate_type, aggregate_id, event_type, partition_key, payload)
      VALUES ('batch', 'btch_b', 'fct.fulfillment.batch.v1', ${PROG_B}, ${'{"programId":"prog_b"}'}::jsonb)
    `

    const captured: Captured = {}
    const publisher = new InMemoryPublisher()
    const published = await relayOnce(
      roleClient(fulfillmentDb, 'fulfillment_relay', captured) as unknown as OutboxClient,
      publisher,
    )

    expect(published).toBe(2)
    expect(publisher.published).toHaveLength(2)
    expect(captured.user).toBe('fulfillment_relay')

    const unpub = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM outbox WHERE published_at IS NULL
    `
    expect(Number(unpub[0]!.n)).toBe(0)
  })

  // PROOF 2: the engine lease-scan split.
  // (a) under fulfillment_engine (no GUC) the predicate-free scan claims due
  //     timers across BOTH programs and marks them fired (SELECT+UPDATE
  //     saga_timer under the engine role suffices).
  it('proof 2a ENGINE: claimAndFireDueTimers under fulfillment_engine claims due timers for BOTH programs, no GUC; current_user = fulfillment_engine', async () => {
    await seedTwoProgramTimers(new Date(Date.now() - 60_000))

    const captured: Captured = {}
    const fired: string[] = []
    const firedIds = await claimAndFireDueTimers(
      roleClient(fulfillmentDb, 'fulfillment_engine', captured) as unknown as EngineClient,
      new Date(),
      async (timer) => {
        fired.push(timer.instanceId)
      },
    )

    expect(firedIds).toHaveLength(2)
    expect(new Set(fired)).toEqual(new Set([SAGA_A, SAGA_B]))
    expect(captured.user).toBe('fulfillment_engine')

    const pending = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM saga_timer WHERE status = 'pending'
    `
    expect(Number(pending[0]!.n)).toBe(0)
  })

  // (b) the per-instance domain effect (batch birth) runs under fulfillment_write
  //     bound to the instance's OWN program, and trips WITH CHECK on a wrong one.
  it('proof 2b EFFECT: batch birth under fulfillment_write succeeds for its own program and trips WITH CHECK on a wrong program', async () => {
    // Correct program: GUC = A, write program A -> ok.
    await fulfillmentDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_write')
      await tx.$queryRawUnsafe(`SELECT set_config('app.program_id', '${PROG_A}', true)`)
      await tx.$executeRawUnsafe(
        `INSERT INTO batch (id, tenant_id, program_id, status, trigger_reason, unit_count, updated_at)
         VALUES (gen_random_uuid(), '${TENANT_A}', '${PROG_A}', 'BORN', 'MANUAL', 0, now())`,
      )
    })

    // Wrong program: GUC = A, write program B -> WITH CHECK violation.
    await expect(
      fulfillmentDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_write')
        await tx.$queryRawUnsafe(`SELECT set_config('app.program_id', '${PROG_A}', true)`)
        await tx.$executeRawUnsafe(
          `INSERT INTO batch (id, tenant_id, program_id, status, trigger_reason, unit_count, updated_at)
           VALUES (gen_random_uuid(), '${TENANT_B}', '${PROG_B}', 'BORN', 'MANUAL', 0, now())`,
        )
      }),
    ).rejects.toThrow(/row-level security|violates|policy/i)
  })

  // (c) THE LOAD-BEARING NEGATIVE: a single-program fulfillment_write (GUC = A)
  //     cannot serve as the lease-scan role. The scan sees both programs' due
  //     timers (saga_timer is not read-restricted), but the cross-program effect
  //     fan-out includes program B, whose batch birth trips WITH CHECK under the
  //     pinned GUC = A. So the whole single-GUC drive fails: this is exactly why
  //     the engine needs its own predicate-free role (proof 2a) with each effect
  //     opening its OWN single-program transaction, NOT fulfillment_write.
  it('proof 2c NEGATIVE: driving the cross-program effect fan-out under one fulfillment_write pinned to program A FAILS on program B (WITH CHECK)', async () => {
    await seedTwoProgramTimers(new Date(Date.now() - 60_000))

    await expect(
      fulfillmentDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_write')
        await tx.$queryRawUnsafe(`SELECT set_config('app.program_id', '${PROG_A}', true)`)

        // The claim scan: sees BOTH programs' instances (no read restriction).
        const due = await tx.$queryRawUnsafe<{ program_id: string; tenant_id: string }[]>(
          `SELECT bp.program_id::text AS program_id, bp.tenant_id::text AS tenant_id
           FROM saga_timer t JOIN batch_pool bp ON bp.pm_instance_id = t.instance_id
           WHERE t.status = 'pending' ORDER BY bp.program_id ASC`,
        )
        expect(due.map((d) => d.program_id)).toEqual([PROG_A, PROG_B])

        // The effect fan-out, forced into this single pinned-GUC transaction:
        // program B's batch birth trips WITH CHECK (B != A), aborting the whole
        // drive. This is the negative the Fork-B split exists to avoid.
        for (const d of due) {
          await tx.$executeRawUnsafe(
            `INSERT INTO batch (id, tenant_id, program_id, status, trigger_reason, unit_count, updated_at)
             VALUES (gen_random_uuid(), '${d.tenant_id}', '${d.program_id}', 'BORN', 'MAX_WAIT', 0, now())`,
          )
        }
      }),
    ).rejects.toThrow(/row-level security|violates|policy/i)

    // The failed single-GUC drive rolled back entirely: no batch survived.
    const batches = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batch`
    expect(Number(batches[0]!.n)).toBe(0)
  })

  // PROOF 3: the appender drains authz.audit payloads from BOTH the fulfillment
  // and tms sources and appends them to auth.authz_audit under auth_appender.
  // C4: the appender NEVER reads tms/fulfillment. Each context's OWN relay
  // (fulfillment_relay, tms_relay) drains its own outbox and hands the payload
  // over; the appender only appends to the auth schema.
  it('proof 3 APPENDER: consumeAuthzAudit under auth_appender appends payloads drained from BOTH the fulfillment and tms relays; dedup on payload.id; chain intact; current_user = auth_appender', async () => {
    // fulfillment source: the edge emits, fulfillment_relay drains its OWN outbox.
    await emitVendorAuthzAudit(
      fulfillmentDb,
      record({
        principalId: 'api_courier_1',
        cls: 6,
        operation: 'shipment:submit-status',
        decision: 'ALLOW',
        outcome: 'authorized',
        actorChannel: 'vendor-edge',
        traceId: 'trace-ful',
      }),
    )
    const fulPub = new InMemoryPublisher()
    await relayOnce(
      roleClient(fulfillmentDb, 'fulfillment_relay', {}) as unknown as OutboxClient,
      fulPub,
    )
    const fulPayload = fulPub.published.find((m) => m.eventType === 'authz.audit')!.payload as {
      id: string
    } & AuthzAuditRecord

    // tms source: seed tms.outbox as owner, tms_relay drains its OWN outbox.
    const tmsEvent = buildAuthzAuditEvent(
      record({
        principalId: 'api_bank_1',
        cls: 6,
        operation: 'file:ingest',
        decision: 'ALLOW',
        outcome: 'authorized',
        actorChannel: 'vendor-edge',
        traceId: 'trace-tms',
      }),
    )
    await tmsDb.$executeRawUnsafe(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, partition_key, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      tmsEvent.aggregateType,
      tmsEvent.aggregateId,
      tmsEvent.eventType,
      tmsEvent.partitionKey,
      JSON.stringify(tmsEvent.payload),
    )
    const tmsPub = new InMemoryPublisher()
    await relayOnce(roleClient(tmsDb, 'tms_relay', {}) as unknown as OutboxClient, tmsPub)
    const tmsPayload = tmsPub.published.find((m) => m.eventType === 'authz.audit')!.payload as {
      id: string
    } & AuthzAuditRecord

    // The appender: appends BOTH under auth_appender (auth schema only).
    const captured: Captured = {}
    const r1 = await consumeAuthzAudit(
      roleClient(authDb, 'auth_appender', captured) as unknown as AuthDb,
      fulPayload,
    )
    const r2 = await consumeAuthzAudit(
      roleClient(authDb, 'auth_appender', captured) as unknown as AuthDb,
      tmsPayload,
    )
    expect(r1.appended).toBe(true)
    expect(r2.appended).toBe(true)
    expect(r1.seq).toBe(1)
    expect(r2.seq).toBe(2)
    expect(captured.user).toBe('auth_appender')

    // Dedup on payload.id: a redelivery of the fulfillment payload is a no-op.
    const r3 = await consumeAuthzAudit(
      roleClient(authDb, 'auth_appender', {}) as unknown as AuthDb,
      fulPayload,
    )
    expect(r3.appended).toBe(false)

    // Exactly two rows, hash-chain intact.
    const count = await authDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM authz_audit`
    expect(Number(count[0]!.n)).toBe(2)
    const verified = await verifyAuthzChain(authDb)
    expect(verified.ok).toBe(true)
    expect(verified.length).toBe(2)
  })

  // Role catalog: each new infra role is a non-owner, has NO BYPASSRLS, cannot
  // log in, and has USAGE on its OWN schema only (the database-level C4
  // backstop). No cross-schema USAGE, no table ownership.
  it('check 3 catalog: fulfillment_relay, fulfillment_engine, auth_appender are non-owner, no BYPASSRLS, USAGE own schema only', async () => {
    for (const [role, ownSchema, otherSchema] of [
      ['fulfillment_relay', 'fulfillment', 'auth'],
      ['fulfillment_engine', 'fulfillment', 'auth'],
      ['auth_appender', 'auth', 'fulfillment'],
    ] as const) {
      const attrs = await fulfillmentDb.$queryRawUnsafe<
        { rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]
      >(`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = '${role}'`)
      expect(attrs).toHaveLength(1)
      expect(attrs[0]!.rolsuper).toBe(false)
      expect(attrs[0]!.rolbypassrls).toBe(false)
      expect(attrs[0]!.rolcanlogin).toBe(false)

      const owned = await fulfillmentDb.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM pg_class c JOIN pg_roles r ON c.relowner = r.oid WHERE r.rolname = '${role}'`,
      )
      expect(Number(owned[0]!.n)).toBe(0)

      const usage = await fulfillmentDb.$queryRawUnsafe<
        { own_usage: boolean; other_usage: boolean }[]
      >(
        `SELECT has_schema_privilege('${role}', '${ownSchema}', 'USAGE') AS own_usage,
                has_schema_privilege('${role}', '${otherSchema}', 'USAGE') AS other_usage`,
      )
      expect(usage[0]!.own_usage).toBe(true)
      expect(usage[0]!.other_usage).toBe(false)
    }
  })
})

// Seed saga_instance + batch_pool + a due saga_timer for two programs (A, B).
async function seedTwoProgramTimers(fireAt: Date): Promise<void> {
  for (const [saga, tenant, program] of [
    [SAGA_A, TENANT_A, PROG_A],
    [SAGA_B, TENANT_B, PROG_B],
  ] as const) {
    await fulfillmentDb.$executeRawUnsafe(
      `INSERT INTO saga_instance (id, flow_type, flow_version, status, updated_at)
       VALUES ('${saga}', 'batching_pool', 1, 'running', now())`,
    )
    await fulfillmentDb.$executeRawUnsafe(
      `INSERT INTO batch_pool (id, tenant_id, program_id, pm_instance_id, created_at)
       VALUES (gen_random_uuid(), '${tenant}', '${program}', '${saga}', now())`,
    )
    await fulfillmentDb.$executeRawUnsafe(
      `INSERT INTO saga_timer (instance_id, fire_at, purpose, status)
       VALUES ('${saga}', '${fireAt.toISOString()}', 'max_wait', 'pending')`,
    )
  }
}
