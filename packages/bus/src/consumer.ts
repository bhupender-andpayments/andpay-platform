import type { EachMessagePayload, Kafka } from 'kafkajs'
import { decode, type Envelope } from '@andpay/envelope'
import { isEnvelopeTopic } from './topics.js'

export interface ConsumerHandle {
  stop: () => Promise<void>
}

/**
 * Run a consumer that decodes each message's E4 envelope and hands it to the
 * caller. Used by the round-trip acceptance test and by the reference process
 * manager to advance on facts. Consumers are idempotent via the inbox (E6); this
 * helper only decodes and dispatches.
 *
 * THE CODEC IS CHOSEN BY THE TOPIC, from the same `isEnvelopeTopic` the
 * PUBLISHER consults. `authz.audit` is the one documented channel carrying a
 * raw record rather than an E4 envelope, and this side used to `decode()`
 * everything unconditionally: the first process ever to subscribe to it would
 * have thrown on its first record. That stayed latent only because nothing
 * consumed the channel until the auth consumer arrived.
 *
 * Reading the policy from ONE place is the point. Two independent notions of
 * which topics carry envelopes would eventually disagree, and the failure would
 * be a message judged by the wrong codec on one side only.
 */
export async function runFactConsumer(
  kafka: Kafka,
  opts: {
    groupId: string
    topics: string[]
    fromBeginning?: boolean
    onEnvelope: (envelope: Envelope, raw: EachMessagePayload) => Promise<void>
    /**
     * Handler for the raw-payload channels. Required to consume one: a caller
     * that subscribes without supplying this is TOLD, loudly, rather than
     * having the record silently dropped or mis-decoded. A dropped audit record
     * is precisely the outcome this path exists to prevent.
     */
    onRawPayload?: (payload: unknown, raw: EachMessagePayload) => Promise<void>
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
      if (!isEnvelopeTopic(payload.topic)) {
        if (!opts.onRawPayload) {
          throw new Error(
            `topic "${payload.topic}" carries a raw payload, not an E4 envelope, and no onRawPayload handler was supplied`,
          )
        }
        await opts.onRawPayload(JSON.parse(payload.message.value.toString('utf8')), payload)
        return
      }
      const envelope = decode(payload.message.value)
      await opts.onEnvelope(envelope, payload)
    },
  })
  return { stop: () => consumer.disconnect() }
}
