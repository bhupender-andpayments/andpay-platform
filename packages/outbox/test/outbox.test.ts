import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaClient } from '../generated/client/index.js'
import { enqueue, onceWithin, relayOnce, InMemoryPublisher } from '../src/index.js'
import type { OutboxEvent } from '../src/index.js'

const url =
  process.env.OUTBOX_TEST_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=outbox_test'

const prisma = new PrismaClient({ datasourceUrl: url })

const event = (overrides: Partial<OutboxEvent> = {}): OutboxEvent => ({
  aggregateType: 'merchant',
  aggregateId: 'mrch_1',
  eventType: 'fct.identity.merchant.v1',
  partitionKey: 'mrch_1',
  payload: { id: 'mrch_1', status: 'active' },
  ...overrides,
})

beforeAll(async () => {
  await prisma.$connect()
})
afterAll(async () => {
  await prisma.$disconnect()
})
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE outbox, inbox')
})

describe('@andpay/outbox', () => {
  // Acceptance 1
  it('leaves no outbox row when the enclosing transaction rolls back', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueue(tx, event())
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await prisma.outbox.count()).toBe(0)
  })

  it('commits the outbox row atomically with the transaction', async () => {
    await prisma.$transaction(async (tx) => {
      await enqueue(tx, event())
    })
    const rows = await prisma.outbox.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.eventType).toBe('fct.identity.merchant.v1')
    expect(rows[0]?.payload).toEqual({ id: 'mrch_1', status: 'active' })
    expect(rows[0]?.publishedAt).toBeNull()
  })

  // Acceptance 2
  it('refuses to enqueue outside a transaction (base client throws)', async () => {
    // The base client is structurally accepted but rejected at runtime because
    // it exposes $transaction, which a transaction client does not.
    await expect(enqueue(prisma, event())).rejects.toThrow(/transaction/i)
    expect(await prisma.outbox.count()).toBe(0)
  })

  // Acceptance 3
  it('relay publishes each unpublished row once and a re-run publishes nothing', async () => {
    await prisma.$transaction((tx) => enqueue(tx, event({ aggregateId: 'mrch_1', partitionKey: 'mrch_1' })))
    await prisma.$transaction((tx) => enqueue(tx, event({ aggregateId: 'mrch_2', partitionKey: 'mrch_2' })))

    const publisher = new InMemoryPublisher()
    const first = await relayOnce(prisma, publisher)
    expect(first).toBe(2)
    expect(publisher.published).toHaveLength(2)

    const second = await relayOnce(prisma, publisher)
    expect(second).toBe(0)
    expect(publisher.published).toHaveLength(2)

    expect(await prisma.outbox.count({ where: { publishedAt: null } })).toBe(0)
  })

  it('relay preserves created_at order in the published batch', async () => {
    await prisma.$transaction((tx) => enqueue(tx, event({ aggregateId: 'mrch_a', partitionKey: 'mrch_a' })))
    await prisma.$transaction((tx) => enqueue(tx, event({ aggregateId: 'mrch_b', partitionKey: 'mrch_b' })))
    const publisher = new InMemoryPublisher()
    await relayOnce(prisma, publisher)
    expect(publisher.published.map((m) => m.aggregateId)).toEqual(['mrch_a', 'mrch_b'])
  })

  // Acceptance 4
  it('runs onceWithin exactly once for a dedup key and skips the second call', async () => {
    let runs = 0
    const first = await prisma.$transaction((tx) =>
      onceWithin(tx, 'consumer_a', 'dedup_1', async () => {
        runs++
      }),
    )
    const second = await prisma.$transaction((tx) =>
      onceWithin(tx, 'consumer_a', 'dedup_1', async () => {
        runs++
      }),
    )
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(runs).toBe(1)
  })

  it('runs onceWithin exactly once under concurrent callers with the same key', async () => {
    let runs = 0
    const results = await Promise.all([
      prisma.$transaction((tx) => onceWithin(tx, 'consumer_b', 'dedup_2', async () => { runs++ })),
      prisma.$transaction((tx) => onceWithin(tx, 'consumer_b', 'dedup_2', async () => { runs++ })),
      prisma.$transaction((tx) => onceWithin(tx, 'consumer_b', 'dedup_2', async () => { runs++ })),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(runs).toBe(1)
  })

  it('rolls back the inbox row if the effect throws, so it can be retried', async () => {
    await expect(
      prisma.$transaction((tx) =>
        onceWithin(tx, 'consumer_c', 'dedup_3', async () => {
          throw new Error('effect failed')
        }),
      ),
    ).rejects.toThrow('effect failed')
    // no inbox row persisted, so a retry can run
    let runs = 0
    const retry = await prisma.$transaction((tx) =>
      onceWithin(tx, 'consumer_c', 'dedup_3', async () => {
        runs++
      }),
    )
    expect(retry).toBe(true)
    expect(runs).toBe(1)
  })
})
