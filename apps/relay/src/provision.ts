import { Kafka, logLevel } from 'kafkajs'
import { provisionTopics, SOUNDBOX_TOPICS, retryAndDlqTopics, type TopicSpec } from '@andpay/bus'

/**
 * Topic provisioning, as its own ONE-SHOT command.
 *
 * Kept out of the relay process on purpose. provisionTopics is config-as-code
 * applied out of band by CI or ops, never a runtime control-plane call (S23):
 * producers publish to already-provisioned topics and never create them. The
 * build plan folded "provision topics" into the relay step; splitting it is the
 * only way to satisfy both the plan and S23.
 *
 * Idempotent, so re-running creates nothing the second time.
 *
 *   pnpm --filter @andpay/relay provision
 */

/**
 * Every fact topic, plus the retry ladder and DLQ for each.
 *
 * The ladder is provisioned NOW even though nothing consumes yet (step 1), and
 * that is deliberate: it is what makes causal ordering a non-problem. A
 * consumer that receives an enrollment fact before the merchant projection
 * exists is SUPPOSED to throw, land on retry.1, and succeed on a later attempt.
 * That is why the "monotonic sequence column" recommendation in older docs is
 * wrong and must not be built: Identity's four facts carry four different
 * partition keys, so Kafka gives no cross-partition ordering to sequence in the
 * first place.
 */
export function allTopics(): TopicSpec[] {
  return SOUNDBOX_TOPICS.flatMap((spec) => [spec, ...retryAndDlqTopics(spec.name)])
}

async function main(): Promise<void> {
  const raw = process.env.KAFKA_BROKERS
  if (raw === undefined || raw.trim() === '') throw new Error('KAFKA_BROKERS is required and was not set')
  const brokers = raw.split(',').map((b) => b.trim()).filter((b) => b !== '')

  const kafka = new Kafka({ clientId: 'andpay-relay-provision', brokers, logLevel: logLevel.ERROR })
  const admin = kafka.admin()
  await admin.connect()
  try {
    const result = await provisionTopics(admin, allTopics())
    console.info(`[provision] created ${String(result.created.length)}, already present ${String(result.existing.length)}`)
    for (const name of result.created) console.info(`[provision]   + ${name}`)
  } finally {
    await admin.disconnect()
  }
}

main().catch((err: unknown) => {
  console.error('[provision] fatal:', err)
  process.exitCode = 1
})
