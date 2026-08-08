import { describe, it, expect } from 'vitest'
import type { Producer } from 'kafkajs'
import type { OutboxMessage } from '@andpay/outbox'
import { KafkaPublisher, isEnvelopeTopic } from '../src/index.js'
import { BusError } from '../src/errors.js'

// B-3. `authz.audit` is the one documented non-envelope channel on the bus.
//
// This was found by running the relay for the first time, not by reading code:
// the first live drain of fulfillment.outbox failed with "payload is not a
// valid E4 envelope". Because relayOnce claims, publishes and stamps in ONE
// transaction, that single row rolled back the whole batch and the identical
// batch would have been re-claimed forever. One audit row wedged the entire
// context's outbox.
//
// The demo pump hid it completely: it has no route for authz.audit, so it
// counted `skipped:` and stamped the rows published. These rows had never
// actually crossed a wire.

interface Sent {
  topic: string
  key: string
  value: string
}

function fakeProducer(sent: Sent[]): Producer {
  return {
    send: async (record: { topic: string; messages: { key: string; value: Buffer }[] }) => {
      for (const m of record.messages) {
        sent.push({ topic: record.topic, key: m.key, value: m.value.toString('utf8') })
      }
      return []
    },
  } as unknown as Producer
}

function row(overrides: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    id: 'row-1',
    aggregateType: 'authz_audit',
    aggregateId: 'prn_1',
    eventType: 'authz.audit',
    partitionKey: 'prn_1',
    payload: {},
    headers: null,
    createdAt: new Date('2026-08-08T18:00:00.000Z'),
    ...overrides,
  } as unknown as OutboxMessage
}

// The exact shape buildAuthzAuditEvent (@andpay/audit) enqueues, and the exact
// shape consumeAuthzAudit (services/auth) takes: the raw record plus an id.
// Copied from a real row observed in fulfillment.outbox, not invented.
const REAL_AUDIT_PAYLOAD = {
  id: '5ba8a013-c55b-4f00-b3f6-0651ce30bc66',
  cls: 6,
  outcome: 'denied',
  traceId: 't-a',
  decision: 'DENY',
  operation: 'shipment:submit-status',
  reasonCode: 'credential-unknown',
  principalId: 'api_x',
  actorChannel: 'vendor-edge',
}

const VALID_ENVELOPE = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'fct.fulfillment.batch.v1',
  version: 1,
  timestamp: '2026-08-08T18:00:00.000Z',
  subject: 'btch_1',
  dedupKey: 'dedup-1',
  traceId: 'trace-1',
  payload: { ok: true },
}

describe('isEnvelopeTopic', () => {
  it('treats every fact and command channel as an envelope channel', () => {
    for (const t of [
      'fct.identity.merchant.v1',
      'fct.tms.bank_file_row.v1',
      'fct.fulfillment.batch.v1',
      'cmd.fulfillment.batch.v1',
      'cfg.auth.credential.v1',
    ]) {
      expect(isEnvelopeTopic(t), `${t} must carry an envelope`).toBe(true)
    }
  })

  it('exempts the auth-internal audit channel', () => {
    expect(isEnvelopeTopic('authz.audit')).toBe(false)
  })

  it('exempts its retry ladder and DLQ, which inherit the base contract', () => {
    // A redelivery must not be re-validated under a different rule than the
    // original, or a row would publish once and then wedge on retry.
    for (const t of ['authz.audit.retry.1', 'authz.audit.retry.2', 'authz.audit.retry.3', 'authz.audit.dlq']) {
      expect(isEnvelopeTopic(t), `${t} must inherit the raw contract`).toBe(false)
    }
  })

  it('does NOT exempt a fact topic that merely looks similar', () => {
    expect(isEnvelopeTopic('fct.authz.audit.v1')).toBe(true)
    expect(isEnvelopeTopic('authz.audit.something')).toBe(true)
  })
})

describe('KafkaPublisher codec', () => {
  it('publishes a real authz.audit record instead of rejecting it', async () => {
    const sent: Sent[] = []
    await new KafkaPublisher(fakeProducer(sent)).publish([row({ payload: REAL_AUDIT_PAYLOAD })])

    expect(sent).toHaveLength(1)
    expect(sent[0]!.topic).toBe('authz.audit')
    // The consumer dedups on the DELIVERED payload.id, so it must survive the
    // wire byte for byte. Re-minting it would double-append on every redelivery.
    expect(JSON.parse(sent[0]!.value)).toEqual(REAL_AUDIT_PAYLOAD)
  })

  it('keys the audit record by principal, so one principal stays ordered', () => {
    // The chain is appended by a single consumer, but keying still matters:
    // E5 ordering within a partition is what keeps one principal's decisions in
    // order across a redelivery.
    expect(row().partitionKey).toBe('prn_1')
  })

  it('still ENCODES a fact channel as an envelope', async () => {
    const sent: Sent[] = []
    await new KafkaPublisher(fakeProducer(sent)).publish([
      row({ eventType: 'fct.fulfillment.batch.v1', payload: VALID_ENVELOPE }),
    ])
    expect(JSON.parse(sent[0]!.value)).toEqual(VALID_ENVELOPE)
  })

  it('still REJECTS a malformed payload on a fact channel', async () => {
    // The exemption must not become a hole: garbage on a fact topic still fails
    // loudly rather than reaching consumers as an undecodable message.
    const sent: Sent[] = []
    await expect(
      new KafkaPublisher(fakeProducer(sent)).publish([
        row({ eventType: 'fct.fulfillment.batch.v1', payload: { not: 'an envelope' } }),
      ]),
    ).rejects.toThrow(BusError)
    expect(sent, 'nothing may be published when validation fails').toHaveLength(0)
  })

  it('a batch MIXING an audit row and a fact row publishes both', async () => {
    // THE REGRESSION THAT MATTERS. relayOnce claims a mixed batch in one
    // transaction, so before this fix the audit row threw and took the fact row
    // down with it, permanently. Both must now cross the wire.
    const sent: Sent[] = []
    await new KafkaPublisher(fakeProducer(sent)).publish([
      row({ id: 'a', payload: REAL_AUDIT_PAYLOAD }),
      row({ id: 'b', eventType: 'fct.fulfillment.batch.v1', payload: VALID_ENVELOPE }),
    ])
    expect(sent.map((s) => s.topic)).toEqual(['authz.audit', 'fct.fulfillment.batch.v1'])
  })
})
