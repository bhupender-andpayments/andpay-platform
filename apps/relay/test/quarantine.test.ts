import { describe, it, expect } from 'vitest'
import type { Producer } from 'kafkajs'
import type { OutboxMessage, PublisherPort } from '@andpay/outbox'
import { BusError, KafkaPublisher } from '@andpay/bus'
import { QuarantiningPublisher, type QuarantineRecord } from '../src/quarantine.js'

interface Sent {
  topic: string
  value: string
}

function fakeProducer(sent: Sent[]): Producer {
  return {
    send: async (rec: { topic: string; messages: { key: string; value: Buffer }[] }) => {
      for (const m of rec.messages) sent.push({ topic: rec.topic, value: m.value.toString('utf8') })
      return []
    },
  } as unknown as Producer
}

function row(overrides: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    id: 'row-1',
    aggregateType: 'batch',
    aggregateId: 'btch_1',
    eventType: 'fct.fulfillment.batch.v1',
    partitionKey: 'btch_1',
    payload: {},
    headers: null,
    createdAt: new Date('2026-08-08T18:00:00.000Z'),
    ...overrides,
  } as unknown as OutboxMessage
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

/** Stands for the broker being unreachable: a TRANSIENT failure. */
class UnreachableBroker implements PublisherPort {
  async publish(): Promise<void> {
    throw new Error('ECONNREFUSED: broker unreachable')
  }
}

describe('QuarantiningPublisher: permanent failures', () => {
  it('routes an unencodable row to its DLQ instead of wedging the outbox', async () => {
    const sent: Sent[] = []
    const producer = fakeProducer(sent)
    const publisher = new QuarantiningPublisher(new KafkaPublisher(producer), producer)

    await expect(publisher.publish([row({ payload: { not: 'an envelope' } })])).resolves.toBeUndefined()

    expect(sent.map((s) => s.topic)).toEqual(['fct.fulfillment.batch.v1.dlq'])
  })

  it('keeps the ORIGINAL payload and says why, because the DLQ is evidence', async () => {
    const sent: Sent[] = []
    const producer = fakeProducer(sent)
    await new QuarantiningPublisher(new KafkaPublisher(producer), producer).publish([
      row({ id: 'row-42', payload: { not: 'an envelope' } }),
    ])

    const record = JSON.parse(sent[0]!.value) as Record<string, unknown>
    expect(record.payload).toEqual({ not: 'an envelope' })
    expect(record.sourceOutboxId).toBe('row-42')
    expect(record.sourceTopic).toBe('fct.fulfillment.batch.v1')
    expect(String(record.reason)).toContain('not a valid E4 envelope')
  })

  it('does NOT block the rest of the batch, which is the whole point', async () => {
    // relayOnce claims a batch in one transaction. Before quarantine, the bad
    // row threw and took every good row with it, permanently.
    const sent: Sent[] = []
    const producer = fakeProducer(sent)
    await new QuarantiningPublisher(new KafkaPublisher(producer), producer).publish([
      row({ id: 'bad', payload: { not: 'an envelope' } }),
      row({ id: 'good', payload: VALID_ENVELOPE }),
    ])
    expect(sent.map((s) => s.topic)).toEqual([
      'fct.fulfillment.batch.v1.dlq',
      'fct.fulfillment.batch.v1',
    ])
  })

  it('reports each quarantine, so it can never be silent', async () => {
    const sent: Sent[] = []
    const producer = fakeProducer(sent)
    const seen: QuarantineRecord[] = []
    await new QuarantiningPublisher(new KafkaPublisher(producer), producer, (r) => seen.push(r)).publish([
      row({ payload: { not: 'an envelope' } }),
    ])
    expect(seen).toHaveLength(1)
    expect(seen[0]!.topic).toBe('fct.fulfillment.batch.v1.dlq')
  })
})

describe('QuarantiningPublisher: transient failures', () => {
  it('RETHROWS a broker outage so relayOnce rolls back and retries', async () => {
    // The dangerous inversion. DLQ-ing on a broker blip would quarantine real
    // facts that were never malformed, and they are not replayable from the
    // outbox afterwards because the row would have been stamped.
    const sent: Sent[] = []
    const publisher = new QuarantiningPublisher(new UnreachableBroker(), fakeProducer(sent))

    await expect(publisher.publish([row({ payload: VALID_ENVELOPE })])).rejects.toThrow(/unreachable/)
    expect(sent, 'a transient failure must quarantine NOTHING').toHaveLength(0)
  })

  it('treats only BusError as permanent, never any error', async () => {
    const sent: Sent[] = []
    const producer = fakeProducer(sent)
    const flaky: PublisherPort = {
      publish: async () => {
        throw new TypeError('some internal bug')
      },
    }
    await expect(
      new QuarantiningPublisher(flaky, producer).publish([row({ payload: VALID_ENVELOPE })]),
    ).rejects.toThrow(TypeError)
    expect(sent).toHaveLength(0)
  })

  it('a BusError IS treated as permanent', async () => {
    const sent: Sent[] = []
    const producer = fakeProducer(sent)
    const permanent: PublisherPort = {
      publish: async () => {
        throw new BusError('payload is not a valid E4 envelope; cannot publish')
      },
    }
    await expect(
      new QuarantiningPublisher(permanent, producer).publish([row({ payload: VALID_ENVELOPE })]),
    ).resolves.toBeUndefined()
    expect(sent).toHaveLength(1)
  })
})
