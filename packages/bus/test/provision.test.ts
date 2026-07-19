import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Kafka, logLevel } from 'kafkajs'
import { provisionTopics, type TopicSpec } from '../src/index.js'

const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',')
const kafka = new Kafka({ clientId: 'provision-test', brokers: BROKERS, logLevel: logLevel.ERROR })
const admin = kafka.admin()

const stamp = String(Date.now())
const specs: TopicSpec[] = [
  { name: `test.provision.${stamp}.a`, partitions: 1 },
  { name: `test.provision.${stamp}.b`, partitions: 1 },
]

beforeAll(async () => {
  await admin.connect()
}, 30000)

afterAll(async () => {
  await admin.deleteTopics({ topics: specs.map((s) => s.name) }).catch(() => undefined)
  await admin.disconnect()
}, 30000)

describe('@andpay/bus topic provisioning (acceptance 6, S23)', () => {
  it('creates missing topics and is idempotent on re-apply', async () => {
    const names = specs.map((s) => s.name).sort()

    const first = await provisionTopics(admin, specs)
    expect([...first.created].sort()).toEqual(names)
    expect(first.existing).toEqual([])

    const second = await provisionTopics(admin, specs)
    expect(second.created).toEqual([])
    expect([...second.existing].sort()).toEqual(names)

    const topics = await admin.listTopics()
    for (const s of specs) expect(topics).toContain(s.name)
  }, 30000)
})
