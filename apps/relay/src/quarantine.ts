import type { Producer } from 'kafkajs'
import type { OutboxMessage, PublisherPort } from '@andpay/outbox'
import { BusError, baseTopic } from '@andpay/bus'

/**
 * Publish-side quarantine: the relay half of the retry ladder (plan step 4).
 *
 * THE PROBLEM THIS SOLVES WAS OBSERVED, NOT PREDICTED. `relayOnce` claims,
 * publishes and stamps in ONE transaction. If publishing any single row throws,
 * the whole transaction rolls back, nothing is stamped, and the identical batch
 * is re-claimed on the next tick. So one permanently-unpublishable row wedges
 * its context's ENTIRE outbox forever, and every later fact behind it stops
 * too. A live drain of fulfillment.outbox did exactly that.
 *
 * THE DISTINCTION THAT MAKES THIS SAFE is permanent versus transient:
 *
 *   PERMANENT (BusError): the payload cannot be encoded for its channel, so it
 *   will fail identically on every future attempt. Retrying is pointless and
 *   blocking on it is harmful. It goes to `<topic>.dlq` and the row is allowed
 *   to be stamped, which unblocks everything behind it.
 *
 *   TRANSIENT (anything else, e.g. the broker being unreachable): retrying is
 *   exactly right. The error propagates, relayOnce rolls back, and the batch is
 *   re-claimed next tick with nothing lost.
 *
 * Getting that backwards in either direction is the dangerous part. Treating
 * transient as permanent would DLQ real facts during a broker blip; treating
 * permanent as transient is the wedge this exists to remove.
 *
 * Messages are published ONE AT A TIME rather than as a batch, because a batch
 * publish gives no way to tell which row failed, and quarantining the innocent
 * majority alongside the one bad row would be worse than the wedge.
 */
export interface QuarantineRecord {
  /** The DLQ topic the row was written to. */
  topic: string
  /** The outbox row id, so the original is findable in the source database. */
  outboxId: string
  /** Why it could never be published. Operator-facing, not a stack trace. */
  reason: string
}

export class QuarantiningPublisher implements PublisherPort {
  constructor(
    private readonly inner: PublisherPort,
    private readonly producer: Producer,
    private readonly onQuarantine: (record: QuarantineRecord) => void = () => undefined,
  ) {}

  async publish(messages: OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      try {
        await this.inner.publish([message])
      } catch (err: unknown) {
        if (!(err instanceof BusError)) throw err
        await this.quarantine(message, err)
      }
    }
  }

  /**
   * Writes the row to its channel's DLQ.
   *
   * The record carries the ORIGINAL payload verbatim plus why it was rejected.
   * A quarantined message is evidence for a human, so discarding the payload
   * and keeping only the error would destroy the only copy on the bus. The
   * source outbox row id travels with it so the original is findable in
   * Postgres.
   *
   * Published as raw JSON deliberately: the payload failed envelope validation,
   * so it cannot be encoded as an envelope, and the DLQ is the one place that
   * must accept a message precisely BECAUSE it is malformed.
   */
  private async quarantine(message: OutboxMessage, err: BusError): Promise<void> {
    const topic = `${baseTopic(message.eventType)}.dlq`
    const record: QuarantineRecord = {
      topic,
      outboxId: String(message.id),
      reason: err.message,
    }
    await this.producer.send({
      topic,
      messages: [
        {
          key: message.partitionKey,
          value: Buffer.from(
            JSON.stringify({
              quarantinedAt: new Date().toISOString(),
              reason: err.message,
              sourceOutboxId: String(message.id),
              sourceTopic: message.eventType,
              payload: message.payload,
            }),
          ),
        },
      ],
    })
    this.onQuarantine(record)
  }
}
