import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Kafka, logLevel } from 'kafkajs'
import { PrismaClient } from '../../outbox/generated/client/index.js'
import { enqueue, relayOnce, onceWithin } from '@andpay/outbox'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { KafkaPublisher, runFactConsumer, provisionTopics, SOUNDBOX_TOPICS } from '../src/index.js'

const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',')
const DB_URL =
  process.env.OUTBOX_TEST_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=outbox_test'

const kafka = new Kafka({ clientId: 'roundtrip-test', brokers: BROKERS, logLevel: logLevel.ERROR })
const producer = kafka.producer()
const prisma = new PrismaClient({ datasourceUrl: DB_URL })
const TOPIC = 'fct.identity.merchant.v1'

beforeAll(async () => {
  const admin = kafka.admin()
  await admin.connect()
  await provisionTopics(admin, SOUNDBOX_TOPICS)
  await admin.disconnect()
  await producer.connect()
  await prisma.$connect()
  await prisma.$executeRawUnsafe('TRUNCATE outbox, inbox')
}, 60000)

afterAll(async () => {
  await producer.disconnect()
  await prisma.$disconnect()
}, 30000)

describe('@andpay/bus real Kafka round trip (acceptance 1, E1/E2/E6)', () => {
  it('publishes an outbox row to Kafka, consumes it, and inbox-dedups a re-delivery', async () => {
    const stamp = String(Date.now())
    const subject = `mrch_rt_${stamp}`
    const dedupKey = `${subject}|created`
    const traceId = `trace_${stamp}`
    const envelope = newEnvelope({
      type: TOPIC,
      version: 1,
      subject,
      dedupKey,
      traceId,
      payload: { id: subject, status: 'active' },
    })

    // 1. a row is written to the outbox
    await prisma.$transaction((tx) =>
      enqueue(tx, {
        aggregateType: 'merchant',
        aggregateId: subject,
        eventType: TOPIC,
        partitionKey: subject,
        payload: envelope,
      }),
    )
    const outboxRows = await prisma.outbox.findMany({ where: { partitionKey: subject } })
    expect(outboxRows).toHaveLength(1)
    expect(outboxRows[0]?.publishedAt).toBeNull()

    // 2. the real Kafka publisher publishes it to the topic
    const published = await relayOnce(prisma, new KafkaPublisher(producer))
    expect(published).toBeGreaterThanOrEqual(1)

    // 3. a test consumer consumes it from Kafka
    let resolveConsumed!: (e: Envelope) => void
    const consumedPromise = new Promise<Envelope>((resolve) => {
      resolveConsumed = resolve
    })
    const handle = await runFactConsumer(kafka, {
      groupId: `roundtrip-${stamp}`,
      topics: [TOPIC],
      fromBeginning: true,
      onEnvelope: async (e) => {
        if (e.dedupKey === dedupKey) resolveConsumed(e)
        return Promise.resolve()
      },
    })
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timed out waiting for the Kafka message')), 45000),
    )
    const consumed = await Promise.race([consumedPromise, timeout])
    await handle.stop()

    expect(consumed.subject).toBe(subject)
    expect(consumed.traceId).toBe(traceId) // trace_id propagated end to end
    expect(consumed.payload).toEqual({ id: subject, status: 'active' })

    // 4. the consumer inbox-dedups it: first apply runs the effect once
    let effectRuns = 0
    const first = await prisma.$transaction((tx) =>
      onceWithin(tx, 'roundtrip-consumer', consumed.dedupKey, async () => {
        effectRuns++
      }),
    )
    expect(first).toBe(true)
    expect(effectRuns).toBe(1)
    expect(await prisma.inbox.count({ where: { dedupKey } })).toBe(1)

    // 5. a re-delivery of the same message is a no-op (E6)
    const second = await prisma.$transaction((tx) =>
      onceWithin(tx, 'roundtrip-consumer', consumed.dedupKey, async () => {
        effectRuns++
      }),
    )
    expect(second).toBe(false)
    expect(effectRuns).toBe(1)
  }, 60000)
})
