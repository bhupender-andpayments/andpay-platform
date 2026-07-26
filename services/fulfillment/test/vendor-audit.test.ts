import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { enqueue } from '@andpay/outbox'
import { buildAuthzAuditEvent, type AuthzAuditRecord } from '@andpay/audit'
import { PrismaClient } from '../generated/client/index.js'
import { emitVendorAuthzAudit } from '../src/vendor-audit.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRaw`DELETE FROM outbox WHERE event_type = 'authz.audit'`
})
afterAll(async () => {
  await db.$disconnect()
})

function rec(overrides: Partial<AuthzAuditRecord> = {}): AuthzAuditRecord {
  return {
    principalId: 'api_x',
    cls: 6,
    operation: 'shipment:submit-status',
    decision: 'DENY',
    outcome: 'denied',
    reasonCode: 'credential-unknown',
    actorChannel: 'vendor-edge',
    traceId: 'trace-1',
    ...overrides,
  }
}

interface AuditOutboxRow {
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload: AuthzAuditRecord & { id: string }
}

async function auditRows(): Promise<AuditOutboxRow[]> {
  return db.$queryRaw<AuditOutboxRow[]>`
    SELECT aggregate_type, aggregate_id, event_type, payload
    FROM outbox WHERE event_type = 'authz.audit'
  `
}

describe('emitVendorAuthzAudit (6e edge emission, its OWN tx, separate from any handler tx, E1)', () => {
  it('a rollback of the surrounding transaction leaves ZERO authz.audit outbox rows (E1 atomicity of the underlying enqueue)', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await enqueue(tx, buildAuthzAuditEvent(rec(), 'evt-rollback'))
        throw new Error('force rollback')
      }),
    ).rejects.toThrow('force rollback')
    expect(await auditRows()).toHaveLength(0)
  })

  it('a commit via emitVendorAuthzAudit leaves exactly ONE IDs-only authz.audit outbox row', async () => {
    const record = rec({ traceId: 'trace-commit' })
    await emitVendorAuthzAudit(db, record, 'evt-commit-1')

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.aggregate_type).toBe('authz_audit')
    expect(row.aggregate_id).toBe('api_x')
    expect(row.event_type).toBe('authz.audit')
    expect(row.payload.id).toBe('evt-commit-1')
    expect(row.payload.principalId).toBe('api_x')
    expect(row.payload.cls).toBe(6)
    expect(row.payload.decision).toBe('DENY')
    expect(row.payload.reasonCode).toBe('credential-unknown')
    expect(row.payload.actorChannel).toBe('vendor-edge')
    expect(row.payload.traceId).toBe('trace-commit')

    // IDs-only: no secret ever rides this record.
    const json = JSON.stringify(row.payload)
    expect(json).not.toMatch(/apsk_/)
  })

  it('mints a fresh event id when none is supplied, and each call opens its OWN transaction (two calls land as two rows)', async () => {
    await emitVendorAuthzAudit(db, rec({ traceId: 't-a' }))
    await emitVendorAuthzAudit(db, rec({ traceId: 't-b' }))

    const rows = await auditRows()
    expect(rows).toHaveLength(2)
    const ids = rows.map((r) => r.payload.id)
    expect(new Set(ids).size).toBe(2)
  })
})
