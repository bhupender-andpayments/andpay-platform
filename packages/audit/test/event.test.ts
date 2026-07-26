import { describe, it, expect } from 'vitest'
import { buildAuthzAuditEvent, AUTHZ_AUDIT_EVENT, type AuthzAuditRecord } from '../src/index.js'

const rec = (over: Partial<AuthzAuditRecord> = {}): AuthzAuditRecord => ({
  principalId: 'prn_1', cls: 3, operation: 'login', decision: 'ALLOW', outcome: 'ok', traceId: 't1', ...over,
})

describe('@andpay/audit event builder', () => {
  it('builds the exact OutboxEvent shape', () => {
    const event = buildAuthzAuditEvent(rec(), 'evt-1')
    expect(event).toEqual({
      aggregateType: 'authz_audit',
      aggregateId: 'prn_1',
      eventType: AUTHZ_AUDIT_EVENT,
      partitionKey: 'prn_1',
      payload: {
        id: 'evt-1',
        principalId: 'prn_1',
        cls: 3,
        operation: 'login',
        decision: 'ALLOW',
        outcome: 'ok',
        traceId: 't1',
      },
    })
  })

  it('mints a distinct id when none is supplied', () => {
    const e1 = buildAuthzAuditEvent(rec())
    const e2 = buildAuthzAuditEvent(rec())
    const p1 = e1.payload as { id: string }
    const p2 = e2.payload as { id: string }
    expect(p1.id).toBeTypeOf('string')
    expect(p1.id).not.toBe(p2.id)
  })

  it('carries only IDs-only fields, no secret or PII keys', () => {
    const event = buildAuthzAuditEvent(
      rec({
        resourceIds: ['res_1'],
        reasonCode: 'because',
        acr: 'AAL2',
        authTime: 123,
        asserterSvid: 'svid_1',
        actorChannel: 'human-direct',
      }),
    )
    const payload = event.payload as Record<string, unknown>
    const allowedKeys = new Set([
      'id', 'principalId', 'cls', 'operation', 'decision', 'outcome',
      'resourceIds', 'reasonCode', 'acr', 'authTime', 'asserterSvid', 'actorChannel', 'traceId',
    ])
    for (const key of Object.keys(payload)) {
      expect(allowedKeys.has(key)).toBe(true)
    }
  })
})
