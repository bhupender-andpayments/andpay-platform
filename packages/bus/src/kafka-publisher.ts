import type { Producer } from 'kafkajs'
import type { OutboxMessage, PublisherPort } from '@andpay/outbox'
import { encode, isEnvelope } from '@andpay/envelope'
import { isEnvelopeTopic } from './topics.js'
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
      await this.producer.send({
        topic: message.eventType,
        messages: [
          {
            key: message.partitionKey,
            value: this.encodeValue(message),
          },
        ],
      })
    }
  }

  /**
   * Encodes one outbox row's payload for the wire.
   *
   * Fact and command channels carry an E4 envelope and are validated, so a
   * producer that enqueues garbage on a fact topic still fails loudly here.
   *
   * `authz.audit` is the ONE documented non-envelope channel (see
   * `isEnvelopeTopic` in topics.ts): it is auth-internal, and both its producer
   * (`buildAuthzAuditEvent`) and its consumer (`consumeAuthzAudit`) are already
   * specified around the raw record. Validating it as an envelope was a
   * transport assumption that no channel had ever tested, because the demo pump
   * skips these rows entirely.
   *
   * That assumption was not a harmless error: relayOnce claims, publishes and
   * stamps in ONE transaction, so a throw here rolls back the whole claimed
   * batch and the identical batch is re-claimed on the next tick. A single
   * audit row wedged its context's entire outbox permanently.
   */
  private encodeValue(message: OutboxMessage): Buffer {
    if (!isEnvelopeTopic(message.eventType)) {
      return Buffer.from(JSON.stringify(message.payload))
    }
    const envelope = message.payload
    if (!isEnvelope(envelope)) {
      throw new BusError(
        `outbox row ${message.id} payload is not a valid E4 envelope; cannot publish`,
      )
    }
    return Buffer.from(encode(envelope))
  }
}
