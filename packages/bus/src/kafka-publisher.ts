import type { Producer } from 'kafkajs'
import type { OutboxMessage, PublisherPort } from '@andpay/outbox'
import { encode, isEnvelope } from '@andpay/envelope'
import { BusError } from './errors.js'

/**
 * The real Kafka/MSK publisher, swapped in behind the spec-02 PublisherPort seam
 * (C6). It maps each outbox row to a Kafka record: the topic is the row's
 * event_type, the message key is the row's partition_key (E5 ordering), and the
 * value is the E4 envelope (already stored as the row's payload) encoded by
 * @andpay/envelope. Delivery is at-least-once (E2); consumers dedup on the
 * envelope dedup_key via the inbox (E6).
 *
 * The same adapter targets local Kafka (Redpanda in dev) and AWS MSK in
 * production; MSK IAM/mTLS auth (S11/S12) is client config applied at deploy, not
 * a code change here.
 */
export class KafkaPublisher implements PublisherPort {
  constructor(private readonly producer: Producer) {}

  async publish(messages: OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      const envelope = message.payload
      if (!isEnvelope(envelope)) {
        throw new BusError(
          `outbox row ${message.id} payload is not a valid E4 envelope; cannot publish`,
        )
      }
      await this.producer.send({
        topic: message.eventType,
        messages: [
          {
            key: message.partitionKey,
            value: Buffer.from(encode(envelope)),
          },
        ],
      })
    }
  }
}
