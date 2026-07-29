import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
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

// -----------------------------------------------------------------------------
// check 7 (Task 7, Fork D): orchestrator_write is a DEAD role. The orchestrator
// context has a Prisma project but no services/orchestrator/src (D77 engine
// internals deferred by design), so the role exists for symmetry only: no
// handler runs under it and it holds no grants beyond its own schema USAGE.
// -----------------------------------------------------------------------------
describe('check 7: dead orchestrator_write role (Fork D, no handler, no src)', () => {
  it('orchestrator_write is a dead non-owner role: USAGE on orchestrator only, no table grants, no owned tables, and services/orchestrator/src does not exist', async () => {
    const attrs = await fulfillmentDb.$queryRawUnsafe<
      { rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]
    >(`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'orchestrator_write'`)
    expect(attrs).toHaveLength(1)
    expect(attrs[0]!.rolsuper).toBe(false)
    expect(attrs[0]!.rolbypassrls).toBe(false)
    expect(attrs[0]!.rolcanlogin).toBe(false)

    // USAGE on its own schema only; no other-schema USAGE (C4 backstop).
    const usage = await fulfillmentDb.$queryRawUnsafe<
      { own_usage: boolean; other_usage: boolean }[]
    >(
      `SELECT has_schema_privilege('orchestrator_write', 'orchestrator', 'USAGE') AS own_usage,
              has_schema_privilege('orchestrator_write', 'fulfillment', 'USAGE') AS other_usage`,
    )
    expect(usage[0]!.own_usage).toBe(true)
    expect(usage[0]!.other_usage).toBe(false)

    // Dead: no table privileges anywhere, owns no tables.
    const grants = await fulfillmentDb.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM information_schema.role_table_grants WHERE grantee = 'orchestrator_write'`,
    )
    expect(Number(grants[0]!.n)).toBe(0)
    const owned = await fulfillmentDb.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM pg_class c JOIN pg_roles r ON c.relowner = r.oid WHERE r.rolname = 'orchestrator_write'`,
    )
    expect(Number(owned[0]!.n)).toBe(0)

    // No handler: services/orchestrator/src does not exist (Fork D).
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    expect(existsSync(path.join(repoRoot, 'services/orchestrator/src'))).toBe(false)
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

// -----------------------------------------------------------------------------
// Task 8 (LOAD-BEARING, checks 4/8/10): cross-cutting catalog + negatives.
// The authoritative no-owner PROOF is the per-context runtime current_user
// tests (services/{identity,tms,fulfillment,auth}/test/write_role.test.ts) plus
// the whole-branch audit; here we add the platform-wide catalog assertions and
// the fail-closed negatives no single-context test covers. pg_roles / pg_class
// are cluster-wide, so any connection may assert on every role.
// -----------------------------------------------------------------------------

const TENDD_ROLES = [
  'identity_write', 'identity_read', 'identity_relay',
  'tms_write', 'tms_read', 'tms_relay', 'tms_ops_read',
  'fulfillment_write', 'fulfillment_read', 'fulfillment_relay', 'fulfillment_engine', 'fulfillment_ops_read',
  'auth_write', 'auth_appender',
  'orchestrator_write',
]

describe('check 4: no workload/infra role has SUPERUSER, BYPASSRLS, LOGIN, or table ownership (Task 8)', () => {
  it('every 10d role is a non-owner, non-superuser, non-bypassrls, nologin role owning zero tables', async () => {
    for (const role of TENDD_ROLES) {
      const attrs = await fulfillmentDb.$queryRawUnsafe<
        { rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]
      >(`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = '${role}'`)
      expect(attrs, `role ${role} must exist`).toHaveLength(1)
      expect(attrs[0]!.rolsuper, `${role} rolsuper`).toBe(false)
      expect(attrs[0]!.rolbypassrls, `${role} rolbypassrls`).toBe(false)
      expect(attrs[0]!.rolcanlogin, `${role} rolcanlogin`).toBe(false)
      const owned = await fulfillmentDb.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM pg_class c JOIN pg_roles r ON c.relowner = r.oid WHERE r.rolname = '${role}'`,
      )
      expect(Number(owned[0]!.n), `${role} owns tables`).toBe(0)
    }
  })
})

describe('check 4: a cross-schema write under a context role is denied by Postgres (M-role) (Task 8)', () => {
  it('fulfillment_write cannot write a tms table (no USAGE on schema tms)', async () => {
    await expect(
      fulfillmentDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_write')
        await tx.$executeRawUnsafe(`INSERT INTO tms.assignment (id) VALUES (gen_random_uuid())`)
      }),
    ).rejects.toThrow(/permission denied|denied for schema|does not exist/i)
  })

  // Relocated here from services/auth/test/write_role.test.ts: a per-context
  // file must not name another context schema by qualified identifier (C4 guard
  // check C), so the auth_write cross-schema negative + the write-role
  // own-schema-only USAGE matrix (which must name every schema) live in root.
  it('auth_write cannot write an identity table (no USAGE on schema identity)', async () => {
    await expect(
      authDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE auth_write')
        await tx.$executeRawUnsafe(
          `INSERT INTO identity.tenant (id, display_name, bank_reference_code, status)
           VALUES (gen_random_uuid(), 'X', 'BREF-XS', 'ACTIVE')`,
        )
      }),
    ).rejects.toThrow(/permission denied|denied for schema|does not exist/i)
  })

  it('each context WRITE role has USAGE on its own schema only (no other context schema)', async () => {
    const WRITE_ROLES: Array<[string, string]> = [
      ['identity_write', 'identity'],
      ['tms_write', 'tms'],
      ['fulfillment_write', 'fulfillment'],
      ['auth_write', 'auth'],
    ]
    const ALL = ['identity', 'tms', 'fulfillment', 'auth', 'orchestrator']
    for (const [role, own] of WRITE_ROLES) {
      for (const schema of ALL) {
        const r = await fulfillmentDb.$queryRawUnsafe<{ ok: boolean }[]>(
          `SELECT has_schema_privilege('${role}', '${schema}', 'USAGE') AS ok`,
        )
        expect(r[0]!.ok, `${role} USAGE on ${schema}`).toBe(schema === own)
      }
    }
  })
})

describe('check 10: the no-ALTER-DEFAULT-PRIVILEGES landmine is honored + a planted table fails closed (Task 8)', () => {
  it('no context migration uses ALTER DEFAULT PRIVILEGES', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    let scanned = 0
    for (const svc of ['identity', 'tms', 'fulfillment', 'auth', 'orchestrator']) {
      const migDir = path.join(repoRoot, `services/${svc}/prisma/migrations`)
      if (!existsSync(migDir)) continue
      for (const d of readdirSync(migDir)) {
        const f = path.join(migDir, d, 'migration.sql')
        if (!existsSync(f)) continue
        scanned++
        // Strip `--` comment lines so a comment DOCUMENTING the landmine
        // ("no ALTER DEFAULT PRIVILEGES") is not mistaken for a real statement.
        const sql = readFileSync(f, 'utf8')
          .split('\n')
          .filter((l) => !l.trim().startsWith('--'))
          .join('\n')
          .toUpperCase()
        expect(sql, `${svc}/${d}`).not.toContain('ALTER DEFAULT PRIVILEGES')
      }
    }
    expect(scanned).toBeGreaterThan(0)
  })

  it('a planted new table with no grant fails closed under fulfillment_write until an explicit GRANT is added', async () => {
    try {
      await fulfillmentDb.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS fulfillment.planted_t8 (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`,
      )
      // No GRANT yet: fulfillment_write cannot INSERT (fails closed).
      await expect(
        fulfillmentDb.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_write')
          await tx.$executeRawUnsafe(`INSERT INTO fulfillment.planted_t8 DEFAULT VALUES`)
        }),
      ).rejects.toThrow(/permission denied/i)
      // After an explicit GRANT the same insert succeeds (no ALTER DEFAULT PRIVILEGES relied on).
      await fulfillmentDb.$executeRawUnsafe(
        'GRANT INSERT ON fulfillment.planted_t8 TO fulfillment_write',
      )
      await fulfillmentDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_write')
        await tx.$executeRawUnsafe(`INSERT INTO fulfillment.planted_t8 DEFAULT VALUES`)
      })
      const rows = await fulfillmentDb.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM fulfillment.planted_t8`,
      )
      expect(Number(rows[0]!.n)).toBe(1)
    } finally {
      await fulfillmentDb.$executeRawUnsafe('DROP TABLE IF EXISTS fulfillment.planted_t8')
    }
  })
})

describe('check 1/4: every service file that opens a domain write transaction enters a write role (static tripwire, Task 8)', () => {
  // The authoritative no-owner proof is the per-context runtime current_user
  // tests; this is a source tripwire that fails if a future edit adds a bare
  // (owner-run) domain writer or drops a role entry. Allowlisted files open a
  // $transaction but legitimately enter no WRITE role: program-agnostic
  // delegates whose callers set scope, and read paths (they enter a READ role).
  it('no service src file opens a $transaction domain write without entering a write role', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const ALLOW = new Set([
      'services/fulfillment/src/courier-status.ts', // program-agnostic; callers enter scope
      'services/fulfillment/src/read.ts', // read path (enterReadScope)
      'services/tms/src/read.ts', // read path (enterReadScope)
      'services/fulfillment/src/ops-read.ts',
      'services/tms/src/ops-read.ts',
      'services/auth/src/authz-chain.ts', // the 6e appender path: runs under auth_appender (Task 5, C2)
    ])
    // A file "enters a write role" via the helper OR a raw `SET LOCAL ROLE`
    // (the 10c ops paths use the raw form directly).
    const entersRole = (src: string): boolean =>
      /enterWrite(Scope|Role)\(/.test(src) || /SET LOCAL ROLE/.test(src)
    const offenders: string[] = []
    for (const svc of ['identity', 'tms', 'fulfillment', 'auth']) {
      const dir = path.join(repoRoot, `services/${svc}/src`)
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.ts')) continue
        const rel = `services/${svc}/src/${f}`
        if (ALLOW.has(rel)) continue
        const src = readFileSync(path.join(dir, f), 'utf8')
        if (/\.\$transaction\(/.test(src) && !entersRole(src)) {
          offenders.push(rel)
        }
      }
    }
    expect(offenders, `files opening a write tx without entering a write role: ${offenders.join(', ')}`).toEqual([])
  })
})

describe('check 8: program is resolved server-side, never from a caller parameter (Task 8)', () => {
  // Non-vacuous RUNTIME proof lives in services/tms/test/write_role.test.ts
  // (amendShipTo/activateAssignment resolve program from the target assignment;
  // a spoofed value is ignored). Here: a structural guard that the two D99
  // exemplar writers resolve program via a SELECT from the target and accept no
  // program parameter.
  it('amendShipTo/activateAssignment resolve program_id from the target assignment, not a parameter', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const src = readFileSync(path.join(repoRoot, 'services/tms/src/assignment.ts'), 'utf8')
    const selects = src.match(/SELECT program_id FROM assignment/gi) ?? []
    expect(selects.length, 'amend + activate each resolve program from the target').toBeGreaterThanOrEqual(2)
    expect(/function amendShipTo\([^)]*program/i.test(src), 'amendShipTo takes no program param').toBe(false)
    expect(/function activateAssignment\([^)]*program/i.test(src), 'activateAssignment takes no program param').toBe(false)
  })
})

describe('check 1/4: the standalone vendor-edge 6e emit runs under fulfillment_write, not owner (Task 8)', () => {
  // emitVendorAuthzAudit commits its authz-audit outbox row in its OWN short tx
  // (spec 10a edge 6e). 10d brings it under fulfillment_write (the fulfillment
  // analog of auth.auditStandalone). Non-vacuous: a BEFORE-INSERT guard on
  // outbox rejects any writer that is not fulfillment_write, so a bare owner
  // insert trips it and the real emit only passes because it entered the role.
  it('emitVendorAuthzAudit writes fulfillment.outbox as fulfillment_write; an owner insert trips the guard', async () => {
    await fulfillmentDb.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION fulfillment._assert_fw() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF current_user <> ''fulfillment_write'' THEN RAISE EXCEPTION ''owner write on outbox: %'', current_user; END IF; RETURN NEW; END'`,
    )
    await fulfillmentDb.$executeRawUnsafe(
      `CREATE TRIGGER _assert_fw_trg BEFORE INSERT ON fulfillment.outbox FOR EACH ROW EXECUTE FUNCTION fulfillment._assert_fw()`,
    )
    try {
      // Non-vacuous: a bare owner insert trips the guard.
      await expect(
        fulfillmentDb.$executeRawUnsafe(
          `INSERT INTO fulfillment.outbox (aggregate_type, aggregate_id, event_type, partition_key, payload)
           VALUES ('x', 'x', 'x', 'x', '{}'::jsonb)`,
        ),
      ).rejects.toThrow(/owner write on outbox/i)
      // The real emit entered fulfillment_write first -> guard passes, row lands.
      await emitVendorAuthzAudit(
        fulfillmentDb,
        record({
          principalId: 'api_courier_x',
          cls: 6,
          operation: 'shipment:submit-status',
          decision: 'ALLOW',
          outcome: 'authorized',
          actorChannel: 'vendor-edge',
        }),
      )
      const n = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
      expect(Number(n[0]!.n)).toBe(1)
    } finally {
      await fulfillmentDb.$executeRawUnsafe('DROP TRIGGER IF EXISTS _assert_fw_trg ON fulfillment.outbox')
      await fulfillmentDb.$executeRawUnsafe('DROP FUNCTION IF EXISTS fulfillment._assert_fw()')
    }
  })
})
