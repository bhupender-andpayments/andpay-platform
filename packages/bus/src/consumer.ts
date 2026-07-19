import type { EachMessagePayload, Kafka } from 'kafkajs'
import { decode, type Envelope } from '@andpay/envelope'

export interface ConsumerHandle {
  stop: () => Promise<void>
}

/**
 * Run a consumer that decodes each message's E4 envelope and hands it to the
 * caller. Used by the round-trip acceptance test and by the reference process
 * manager to advance on facts. Consumers are idempotent via the inbox (E6); this
 * helper only decodes and dispatches.
 */
export async function runFactConsumer(
  kafka: Kafka,
  opts: {
    groupId: string
    topics: string[]
    fromBeginning?: boolean
    onEnvelope: (envelope: Envelope, raw: EachMessagePayload) => Promise<void>
  },
): Promise<ConsumerHandle> {
  const consumer = kafka.consumer({ groupId: opts.groupId })
  await consumer.connect()
  for (const topic of opts.topics) {
    await consumer.subscribe({ topic, fromBeginning: opts.fromBeginning ?? true })
  }
  await consumer.run({
    eachMessage: async (payload) => {
      if (!payload.message.value) return
      const envelope = decode(payload.message.value)
      await opts.onEnvelope(envelope, payload)
    },
  })
  return { stop: () => consumer.disconnect() }
}
