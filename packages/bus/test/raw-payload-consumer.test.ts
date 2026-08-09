import { describe, it, expect } from 'vitest'
import type { EachMessagePayload, Kafka } from 'kafkajs'
import type { Envelope } from '@andpay/envelope'
import { runFactConsumer } from '../src/index.js'

// The CONSUME side of B-3, which was left latent because nothing consumed the
// channel yet.
//
// `authz.audit` is the one documented non-envelope topic on the bus: it carries
// a raw authorization record, not an E4 envelope. The PUBLISHER already knows
// this (isEnvelopeTopic, added when the first live drain wedged an outbox). The
// CONSUMER did not: runFactConsumer called decode() on every message
// unconditionally, so the first process to subscribe to authz.audit would have
// thrown on the very first record.
//
// That mattered as soon as Bhupender asked for permission denials to be kept in
// the database ("so we can know who is trying to access the things not allowed
// to"): the auth consumer that appends them is exactly the first subscriber.
//
// The codec policy is read from ONE place for both directions. Two independent
// notions of which topics carry envelopes is how a message gets judged by the
// wrong codec on one side only.

interface Captured {
  handler: (payload: EachMessagePayload) => Promise<void>
  subscribed: string[]
}

function fakeKafka(captured: Captured): Kafka {
  return {
    consumer: () => ({
      connect: async () => undefined,
      subscribe: async ({ topic }: { topic: string }) => {
        captured.subscribed.push(topic)
      },
      run: async ({ eachMessage }: { eachMessage: (p: EachMessagePayload) => Promise<void> }) => {
        captured.handler = eachMessage
      },
      disconnect: async () => undefined,
    }),
  } as unknown as Kafka
}

function message(topic: string, value: unknown): EachMessagePayload {
  return {
    topic,
    partition: 0,
    message: { value: Buffer.from(JSON.stringify(value)), key: null, headers: {} },
  } as unknown as EachMessagePayload
}

const AUDIT_RECORD = {
  id: 'evt-1',
  cls: 6,
  decision: 'DENY',
  outcome: 'scope-denied',
  operation: 'batch:pull-artifacts',
  reasonCode: 'scope-denied',
  principalId: 'prn_1',
  actorChannel: 'api',
  traceId: 'trace-1',
}

describe('runFactConsumer: the one raw-payload channel', () => {
  it('hands an authz.audit record to onRawPayload, never to onEnvelope', async () => {
    const captured: Captured = { handler: async () => undefined, subscribed: [] }
    const envelopes: Envelope[] = []
    const raws: unknown[] = []

    await runFactConsumer(fakeKafka(captured), {
      groupId: 'g',
      topics: ['authz.audit'],
      fromBeginning: false,
      onEnvelope: async (e) => {
        envelopes.push(e)
      },
      onRawPayload: async (p) => {
        raws.push(p)
      },
    })

    await captured.handler(message('authz.audit', AUDIT_RECORD))

    expect(envelopes).toHaveLength(0)
    expect(raws).toEqual([AUDIT_RECORD])
  })

  // The ordinary path must be untouched: this is the change most likely to
  // break every other consumer if the topic test is inverted.
  it('still decodes an ordinary fact topic into an envelope', async () => {
    const captured: Captured = { handler: async () => undefined, subscribed: [] }
    const envelopes: Envelope[] = []
    const raws: unknown[] = []

    await runFactConsumer(fakeKafka(captured), {
      groupId: 'g',
      topics: ['fct.tms.bank_file_row.v1'],
      fromBeginning: false,
      onEnvelope: async (e) => {
        envelopes.push(e)
      },
      onRawPayload: async (p) => {
        raws.push(p)
      },
    })

    const envelope = {
      id: 'e1',
      type: 'fct.tms.bank_file_row.v1',
      version: 1,
      timestamp: '2026-08-09T00:00:00.000Z',
      subject: 's',
      dedupKey: 'd',
      traceId: 't',
      payload: { hello: 'world' },
    }
    await captured.handler(message('fct.tms.bank_file_row.v1', envelope))

    expect(raws).toHaveLength(0)
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0]?.payload).toEqual({ hello: 'world' })
  })

  // A retry rung inherits its base topic's contract, exactly as the publisher
  // does. Judging a redelivery by a different codec than the first delivery is
  // the specific bug isEnvelopeTopic exists to prevent.
  it('treats a retry rung of the raw channel as raw too', async () => {
    const captured: Captured = { handler: async () => undefined, subscribed: [] }
    const raws: unknown[] = []

    await runFactConsumer(fakeKafka(captured), {
      groupId: 'g',
      topics: ['authz.audit.retry.1'],
      fromBeginning: false,
      onEnvelope: async () => undefined,
      onRawPayload: async (p) => {
        raws.push(p)
      },
    })

    await captured.handler(message('authz.audit.retry.1', AUDIT_RECORD))
    expect(raws).toEqual([AUDIT_RECORD])
  })

  // FAILS CLOSED. A caller that subscribes to the raw channel without saying
  // how to handle it must be told, not silently dropped: a dropped audit record
  // is the one outcome this whole path exists to prevent.
  it('throws when a raw channel arrives with no onRawPayload handler', async () => {
    const captured: Captured = { handler: async () => undefined, subscribed: [] }

    await runFactConsumer(fakeKafka(captured), {
      groupId: 'g',
      topics: ['authz.audit'],
      fromBeginning: false,
      onEnvelope: async () => undefined,
    })

    await expect(captured.handler(message('authz.audit', AUDIT_RECORD))).rejects.toThrow(/authz\.audit/)
  })
})
