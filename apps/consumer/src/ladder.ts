import type { Producer } from 'kafkajs'
import type { EachMessagePayload } from 'kafkajs'
import type { Envelope } from '@andpay/envelope'
import { nextLadderTopic, ladderDelayMs, isDlqTopic, DEFAULT_RETRY_LEVELS } from '@andpay/bus'

/**
 * The consume half of the retry ladder (plan step 4).
 *
 * WITHOUT THIS, a handler that throws is a partition-stopper. kafkajs does not
 * commit the offset for a throwing message, so the SAME message is redelivered
 * forever and every later message sharing its partition waits behind it. One
 * unprocessable fact halts a whole rail.
 *
 * With it, a failure is republished one rung up and the offset commits, so the
 * partition keeps moving and the failing message costs only itself. After the
 * last rung it lands in the DLQ, where it stops being retried and starts being
 * evidence.
 *
 * THIS IS ALSO WHAT MAKES CAUSAL ORDERING A NON-PROBLEM, and why the "monotonic
 * sequence column" idea in older docs must not be built. Identity's facts carry
 * four DIFFERENT partition keys, so Kafka offers no ordering between them by
 * design. A consumer that receives an enrollment fact before the merchant
 * projection exists is SUPPOSED to throw; it lands on retry.1 and succeeds once
 * the merchant fact has folded. The demo pump's dependency sort was a
 * workaround for having no ladder, and must not be carried over (task B-2).
 */

export interface DeadLetterInfo {
  topic: string
  dedupKey: string
  reason: string
}

export interface LadderOptions {
  producer: Producer
  handle: (envelope: Envelope) => Promise<void>
  /** Called when a message reaches the DLQ. Never silent: this is the signal a human acts on. */
  onDeadLetter?: (info: DeadLetterInfo) => void
  /** Called on every intermediate retry hop, for visibility into a rail that is struggling but coping. */
  onRetry?: (info: DeadLetterInfo & { nextTopic: string }) => void
  retryLevels?: number
  /** Injected so tests need no real timer. */
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Wraps a handler so a failure moves the message one rung up instead of
 * jamming the partition.
 *
 * The republished value is the ORIGINAL BYTES, never a re-encoded envelope.
 * Re-encoding would risk changing the payload between attempts, and the whole
 * value of a retry is that it is the same message tried again. Why it failed
 * travels in HEADERS instead, so the body stays byte-identical and every rung
 * decodes exactly as the first delivery did.
 */
export function withLadder(opts: LadderOptions): (envelope: Envelope, raw: EachMessagePayload) => Promise<void> {
  const retryLevels = opts.retryLevels ?? DEFAULT_RETRY_LEVELS
  const sleep = opts.sleep ?? realSleep

  return async (envelope: Envelope, raw: EachMessagePayload): Promise<void> => {
    // Backoff happens on the CONSUME side because Kafka has no delayed
    // delivery. It blocks only this rung's partition, never the base topic's,
    // which is why the rungs are separate topics rather than a counter.
    const delay = ladderDelayMs(raw.topic)
    if (delay > 0) await sleep(delay)

    try {
      await opts.handle(envelope)
      return
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      const dedupKey = envelope.dedupKey

      // Defensive: nothing subscribes to a DLQ topic, so this should be
      // unreachable. If it ever is reached, stopping is right. Republishing a
      // DLQ message to itself would be an infinite loop, and nextLadderTopic
      // returns the same topic there precisely so this is detectable.
      if (isDlqTopic(raw.topic)) {
        opts.onDeadLetter?.({ topic: raw.topic, dedupKey, reason })
        return
      }

      const next = nextLadderTopic(raw.topic, retryLevels)
      await opts.producer.send({
        topic: next,
        messages: [
          {
            // The original key, so a message stays on the same partition for
            // its whole journey and one aggregate's retries stay ordered.
            key: raw.message.key,
            value: raw.message.value,
            headers: {
              'x-andpay-retry-from': raw.topic,
              'x-andpay-retry-reason': reason.slice(0, 500),
            },
          },
        ],
      })

      if (isDlqTopic(next)) {
        opts.onDeadLetter?.({ topic: next, dedupKey, reason })
      } else {
        opts.onRetry?.({ topic: raw.topic, nextTopic: next, dedupKey, reason })
      }
      // Returning normally COMMITS the offset, which is the point: the
      // partition moves on and the message continues its own journey.
    }
  }
}

/**
 * The topics a consumer subscribes to: the base topic and every retry rung.
 *
 * NOT the DLQ. A quarantine that is automatically re-consumed is not a
 * quarantine, and it would loop forever on a message that can never succeed.
 * Draining a DLQ is a deliberate human act.
 */
export function ladderTopicsFor(topics: readonly string[], retryLevels = DEFAULT_RETRY_LEVELS): string[] {
  return topics.flatMap((t) => [t, ...Array.from({ length: retryLevels }, (_, i) => `${t}.retry.${String(i + 1)}`)])
}
