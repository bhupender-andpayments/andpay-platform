import { describe, it, expect, vi } from 'vitest'
import type { Producer, EachMessagePayload } from 'kafkajs'
import type { Envelope } from '@andpay/envelope'
import { withLadder, ladderTopicsFor, type DeadLetterInfo } from '../src/ladder.js'

const BASE = 'fct.tms.bank_file_row.v1'

interface Sent {
  topic: string
  key: string
  value: string
  headers: Record<string, string>
}

function fakeProducer(sent: Sent[]): Producer {
  return {
    send: async (rec: {
      topic: string
      messages: { key: Buffer | string; value: Buffer; headers?: Record<string, string> }[]
    }) => {
      for (const m of rec.messages) {
        sent.push({
          topic: rec.topic,
          key: String(m.key),
          value: m.value.toString('utf8'),
          headers: m.headers ?? {},
        })
      }
      return []
    },
  } as unknown as Producer
}

const ENVELOPE = { dedupKey: 'file-1|1', type: BASE } as unknown as Envelope

function delivery(topic: string, value = '{"original":"bytes"}'): EachMessagePayload {
  return {
    topic,
    partition: 0,
    message: { key: Buffer.from('k1'), value: Buffer.from(value) },
  } as unknown as EachMessagePayload
}

const noSleep = async (): Promise<void> => {}

describe('withLadder: the happy path', () => {
  it('commits without republishing when the handler succeeds', async () => {
    const sent: Sent[] = []
    const run = withLadder({ producer: fakeProducer(sent), handle: async () => {}, sleep: noSleep })
    await run(ENVELOPE, delivery(BASE))
    expect(sent).toHaveLength(0)
  })
})

describe('withLadder: failure moves one rung, it does not jam the partition', () => {
  it('republishes to retry.1 and RETURNS, so the offset commits', async () => {
    // Returning normally is the whole mechanism. If this rethrew, kafkajs would
    // not commit and the same message would be redelivered forever, stopping
    // every later message on the partition.
    const sent: Sent[] = []
    const run = withLadder({
      producer: fakeProducer(sent),
      handle: async () => {
        throw new Error('merchant projection not ready')
      },
      sleep: noSleep,
    })

    await expect(run(ENVELOPE, delivery(BASE))).resolves.toBeUndefined()
    expect(sent.map((s) => s.topic)).toEqual([`${BASE}.retry.1`])
  })

  it('republishes the ORIGINAL BYTES, so a retry is the same message tried again', async () => {
    const sent: Sent[] = []
    const run = withLadder({
      producer: fakeProducer(sent),
      handle: async () => {
        throw new Error('boom')
      },
      sleep: noSleep,
    })
    await run(ENVELOPE, delivery(BASE, '{"exact":"payload"}'))
    expect(sent[0]!.value).toBe('{"exact":"payload"}')
  })

  it('carries the reason in HEADERS, leaving the body byte-identical', async () => {
    const sent: Sent[] = []
    const run = withLadder({
      producer: fakeProducer(sent),
      handle: async () => {
        throw new Error('merchant projection not ready')
      },
      sleep: noSleep,
    })
    await run(ENVELOPE, delivery(BASE))
    expect(sent[0]!.headers['x-andpay-retry-from']).toBe(BASE)
    expect(sent[0]!.headers['x-andpay-retry-reason']).toContain('merchant projection not ready')
  })

  it('keeps the original key, so one aggregate stays on one partition', async () => {
    const sent: Sent[] = []
    const run = withLadder({
      producer: fakeProducer(sent),
      handle: async () => {
        throw new Error('boom')
      },
      sleep: noSleep,
    })
    await run(ENVELOPE, delivery(BASE))
    expect(sent[0]!.key).toBe('k1')
  })

  it('walks rung by rung and lands in the DLQ after the last one', async () => {
    const sent: Sent[] = []
    const dead: DeadLetterInfo[] = []
    const run = withLadder({
      producer: fakeProducer(sent),
      handle: async () => {
        throw new Error('always fails')
      },
      onDeadLetter: (i) => dead.push(i),
      sleep: noSleep,
    })

    for (const topic of [BASE, `${BASE}.retry.1`, `${BASE}.retry.2`, `${BASE}.retry.3`]) {
      await run(ENVELOPE, delivery(topic))
    }

    expect(sent.map((s) => s.topic)).toEqual([
      `${BASE}.retry.1`,
      `${BASE}.retry.2`,
      `${BASE}.retry.3`,
      `${BASE}.dlq`,
    ])
    expect(dead, 'reaching the DLQ must be reported, never silent').toHaveLength(1)
    expect(dead[0]!.dedupKey).toBe('file-1|1')
  })

  it('reports intermediate hops separately from dead-lettering', async () => {
    const retries: string[] = []
    const dead: DeadLetterInfo[] = []
    const run = withLadder({
      producer: fakeProducer([]),
      handle: async () => {
        throw new Error('boom')
      },
      onRetry: (i) => retries.push(i.nextTopic),
      onDeadLetter: (i) => dead.push(i),
      sleep: noSleep,
    })
    await run(ENVELOPE, delivery(BASE))
    expect(retries).toEqual([`${BASE}.retry.1`])
    expect(dead).toHaveLength(0)
  })
})

describe('withLadder: backoff', () => {
  it('does not delay a first delivery', async () => {
    const sleep = vi.fn(async () => {})
    const run = withLadder({ producer: fakeProducer([]), handle: async () => {}, sleep })
    await run(ENVELOPE, delivery(BASE))
    expect(sleep).not.toHaveBeenCalled()
  })

  it('waits before HANDLING a retry, which is the only honest place to wait', async () => {
    // Kafka has no delayed delivery, so a retry that fires instantly would just
    // re-fail against a dependency that has not arrived yet.
    const sleep = vi.fn(async () => {})
    const run = withLadder({ producer: fakeProducer([]), handle: async () => {}, sleep })
    await run(ENVELOPE, delivery(`${BASE}.retry.2`))
    expect(sleep).toHaveBeenCalledWith(5_000)
  })
})

describe('ladderTopicsFor', () => {
  it('subscribes to the base topic and every retry rung', () => {
    expect(ladderTopicsFor([BASE])).toEqual([
      BASE,
      `${BASE}.retry.1`,
      `${BASE}.retry.2`,
      `${BASE}.retry.3`,
    ])
  })

  it('NEVER subscribes to the DLQ', () => {
    // A quarantine that is re-consumed automatically is not a quarantine, and
    // it would loop forever on a message that can never succeed.
    expect(ladderTopicsFor([BASE]).some((t) => t.endsWith('.dlq'))).toBe(false)
  })
})
