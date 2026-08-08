/**
 * Retry-ladder navigation (E7): `<topic>` to `<topic>.retry.1` to `.retry.2` to
 * `.retry.3` to `<topic>.dlq`.
 *
 * `retryAndDlqTopics` (topics.ts) MINTS those names at provisioning time; this
 * module NAVIGATES them at runtime. They live in the same package on purpose:
 * if the two ever disagree about the shape of a ladder name, a consumer would
 * publish a retry to a topic that was never created.
 *
 * WHY THIS EXISTS. Without a ladder, a message whose handler throws is never
 * offset-committed, so kafkajs redelivers it forever and the whole PARTITION
 * stops behind it. One unprocessable fact halts every later fact that shares
 * its partition. The ladder converts that into a bounded number of attempts and
 * then a quarantine, so a poison message costs itself and nothing else.
 *
 * The ladder is also what makes causal ordering a non-problem, which is why the
 * "monotonic sequence column" idea in older docs must not be built: a consumer
 * that receives an enrollment fact before the merchant projection exists is
 * SUPPOSED to throw. It lands on retry.1 and succeeds on a later attempt, once
 * the merchant fact has folded.
 */

const LADDER_SUFFIX = /\.(retry\.(\d+)|dlq)$/

/** The default number of retry rungs, matching `retryAndDlqTopics`. */
export const DEFAULT_RETRY_LEVELS = 3

/** Strips any ladder suffix: `fct.x.v1.retry.2` and `fct.x.v1.dlq` both give `fct.x.v1`. */
export function baseTopic(topic: string): string {
  return topic.replace(LADDER_SUFFIX, '')
}

/** True for a terminal quarantine topic. Nothing is ever republished from here. */
export function isDlqTopic(topic: string): boolean {
  return topic.endsWith('.dlq')
}

/**
 * Which rung a topic is on: 0 for the base topic, N for `.retry.N`, and
 * `Infinity` for the DLQ, so a caller comparing against a max never treats the
 * terminal rung as "one more attempt available".
 */
export function ladderLevel(topic: string): number {
  if (isDlqTopic(topic)) return Infinity
  const match = LADDER_SUFFIX.exec(topic)
  if (match?.[2] === undefined) return 0
  return Number(match[2])
}

/**
 * The topic a failed message moves to next.
 *
 * base -> retry.1 -> ... -> retry.N -> dlq, and dlq -> dlq. The DLQ is a fixed
 * point rather than an error: a message that fails while being handled FROM the
 * DLQ must not bounce, and returning the same topic lets a caller detect that
 * with `next === current` instead of catching an exception.
 */
export function nextLadderTopic(topic: string, retryLevels = DEFAULT_RETRY_LEVELS): string {
  const base = baseTopic(topic)
  if (isDlqTopic(topic)) return topic
  const level = ladderLevel(topic)
  if (level >= retryLevels) return `${base}.dlq`
  return `${base}.retry.${String(level + 1)}`
}

/**
 * How long to wait before HANDLING a message read from rung N.
 *
 * Backoff belongs on the consume side, not the publish side: Kafka has no
 * native delayed delivery, so the only honest place to wait is before doing the
 * work. Rung 1 is deliberately short, because the common case is a fact that
 * arrived a beat before its dependency and would succeed almost immediately.
 * Base-topic messages never wait.
 */
export function ladderDelayMs(topic: string): number {
  const level = ladderLevel(topic)
  if (level === 0 || !Number.isFinite(level)) return 0
  return [0, 1_000, 5_000, 15_000][level] ?? 15_000
}
