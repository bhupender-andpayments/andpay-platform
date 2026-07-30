import { describe, it, expect, beforeEach, afterAll, afterEach } from 'vitest'
import { PrismaClient } from '../generated/client/index.js'
import { emitAnalyticsReadAudit, emitAnalyticsCrossTenantAccess } from '../src/audit.js'

// Every connection here is the andpay CLUSTER SUPERUSER, which bypasses any
// grant boundary by superuser status alone; the analytics_write boundary and
// the current_user trigger below only bite once SET LOCAL ROLE analytics_write
// is in force inside the tx (current_user, not session_user, drives the
// check). emitAnalyticsReadAudit/emitAnalyticsCrossTenantAccess open their OWN
// transaction, so the guard proves the LIBRARY function itself entered the
// role, not merely that this test's setup did.
const url =
  process.env.ANALYTICS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const db = new PrismaClient({ datasourceUrl: url })

afterAll(async () => {
  await db.$disconnect()
})

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE analytics.outbox CASCADE')
})

interface OutboxRow {
  event_type: string
  payload: { id: string } & Record<string, unknown>
}

async function outboxRows(): Promise<OutboxRow[]> {
  return db.$queryRaw<OutboxRow[]>`
    SELECT event_type, payload FROM analytics.outbox ORDER BY created_at ASC
  `
}

describe('emitAnalyticsReadAudit: the per-read 6e emit into analytics.outbox (checks 9, 10)', () => {
  it('enqueues exactly ONE authz.audit row, IDs-and-enums only (no PII, no report row)', async () => {
    await emitAnalyticsReadAudit(db, {
      principalId: 'prn_ops_1',
      cls: 3,
      operation: 'analytics:tile-read',
      decision: 'ALLOW',
      resourceIds: ['tile_dispatch_summary'],
      traceId: 'trace-audit-1',
    })
    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event_type).toBe('authz.audit')
    const payload = rows[0]!.payload
    expect(payload.principalId).toBe('prn_ops_1')
    expect(payload.cls).toBe(3)
    expect(payload.operation).toBe('analytics:tile-read')
    expect(payload.decision).toBe('ALLOW')
    expect(payload.outcome).toBe('allowed')
    expect(payload.resourceIds).toEqual(['tile_dispatch_summary'])
    expect(payload.traceId).toBe('trace-audit-1')
    expect(payload.actorChannel).toBe('human-direct')
    // IDs-and-enums only: no report row, no PII field, no secret. The record
    // shape is exhaustively enumerated; a stray key would trip this.
    const allowedKeys = new Set([
      'id', 'principalId', 'cls', 'operation', 'decision', 'outcome',
      'resourceIds', 'reasonCode', 'acr', 'authTime', 'asserterSvid',
      'actorChannel', 'traceId',
    ])
    for (const key of Object.keys(payload)) {
      expect(allowedKeys.has(key), `unexpected key ${key} on the 6e payload`).toBe(true)
    }
  })

  it('a 0-row read still records its authorized attempt (resourceIds may be empty)', async () => {
    await emitAnalyticsReadAudit(db, {
      principalId: 'prn_ops_2',
      cls: 3,
      operation: 'analytics:tile-read',
      decision: 'ALLOW',
      resourceIds: [],
      traceId: 'trace-audit-0row',
    })
    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload.resourceIds).toEqual([])
  })

  it('a DENY decision is durably enqueued, not swallowed', async () => {
    await emitAnalyticsReadAudit(db, {
      principalId: 'prn_ops_3',
      cls: 2,
      operation: 'analytics:report-read',
      decision: 'DENY',
      resourceIds: [],
      traceId: 'trace-audit-deny',
      reasonCode: 'cls_not_authorized',
    })
    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload.decision).toBe('DENY')
    expect(rows[0]!.payload.outcome).toBe('denied')
    expect(rows[0]!.payload.reasonCode).toBe('cls_not_authorized')
  })

  it('runs under analytics_write, not the owner: a BEFORE-INSERT current_user guard passes for the real emit', async () => {
    await db.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION analytics._assert_aw() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF current_user <> ''analytics_write'' THEN RAISE EXCEPTION ''owner write on outbox: %'', current_user; END IF; RETURN NEW; END'`,
    )
    await db.$executeRawUnsafe(
      `CREATE TRIGGER _assert_aw_trg BEFORE INSERT ON analytics.outbox FOR EACH ROW EXECUTE FUNCTION analytics._assert_aw()`,
    )
    try {
      // Non-vacuous: a bare owner insert (no role entered) trips the guard.
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO analytics.outbox (aggregate_type, aggregate_id, event_type, partition_key, payload)
           VALUES ('x', 'x', 'x', 'x', '{}'::jsonb)`,
        ),
      ).rejects.toThrow(/owner write on outbox/i)

      // The real emit entered analytics_write FIRST -> guard passes, row lands.
      await emitAnalyticsReadAudit(db, {
        principalId: 'prn_ops_4',
        cls: 3,
        operation: 'analytics:tile-read',
        decision: 'ALLOW',
        resourceIds: [],
        traceId: 'trace-audit-role',
      })
      const rows = await outboxRows()
      expect(rows).toHaveLength(1)
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS _assert_aw_trg ON analytics.outbox')
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS analytics._assert_aw()')
    }
  })
})

describe('emitAnalyticsCrossTenantAccess: the D99 cross-tenant-access entry (Q5 G3)', () => {
  afterEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE analytics.outbox CASCADE')
  })

  it('emits a DISTINCT second record (operation analytics:cross-tenant-read) IN ADDITION to the per-read 6e', async () => {
    await emitAnalyticsReadAudit(db, {
      principalId: 'prn_ops_5',
      cls: 3,
      operation: 'analytics:tile-read',
      decision: 'ALLOW',
      resourceIds: ['tile_x'],
      traceId: 'trace-audit-ct',
    })
    await emitAnalyticsCrossTenantAccess(db, {
      principalId: 'prn_ops_5',
      operation: 'analytics:tile-read',
      traceId: 'trace-audit-ct',
    })

    const rows = await outboxRows()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.event_type === 'authz.audit')).toBe(true)

    const perRead = rows.find((r) => r.payload.operation === 'analytics:tile-read')!
    const crossTenant = rows.find((r) => r.payload.operation === 'analytics:cross-tenant-read')!
    expect(perRead).toBeDefined()
    expect(crossTenant).toBeDefined()
    expect(perRead.payload.id).not.toBe(crossTenant.payload.id)
    expect(crossTenant.payload.resourceIds).toEqual([])
    expect(crossTenant.payload.decision).toBe('ALLOW')
    expect(crossTenant.payload.principalId).toBe('prn_ops_5')
  })
})
