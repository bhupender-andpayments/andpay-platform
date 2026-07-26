import { randomUUID } from 'node:crypto'
import type { OutboxEvent } from '@andpay/outbox'
import type { AuthzAuditRecord } from './record.js'

/**
 * The 6e authz-audit fact type. AUTH-INTERNAL: consumed to the Auth-owned
 * audit store, never a public fct.* topic.
 */
export const AUTHZ_AUDIT_EVENT = 'authz.audit'

/**
 * Builds the outbox-ready fact for an authz-audit record. Pure: no I/O, no
 * clock read, and no randomness beyond an optional caller-supplied id.
 */
export function buildAuthzAuditEvent(record: AuthzAuditRecord, id?: string): OutboxEvent {
  return {
    aggregateType: 'authz_audit',
    aggregateId: record.principalId,
    eventType: AUTHZ_AUDIT_EVENT,
    partitionKey: record.principalId,
    payload: { id: id ?? randomUUID(), ...record },
  }
}
