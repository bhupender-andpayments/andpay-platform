import { Kafka, logLevel } from 'kafkajs'
import { KafkaPublisher } from '@andpay/bus'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as FulfillmentClient } from '@andpay/fulfillment-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { RELAY_CONTEXTS, assertRelayContextsAreSafe } from './contexts.js'
import { runRelayTick, type DrainResult } from './tick.js'
import { QuarantiningPublisher } from './quarantine.js'
import { resolveTickSeconds, runRelay } from './loop.js'
import type { TransactionalClient } from './role-client.js'

// The production relay process (task B-1, ruling A-6.1: its own app, not a mode
// of apps/scheduler).
//
// It publishes to Kafka and NOTHING ELSE. Consumers are separate per-context
// processes (the ratified shape), which is what keeps a slow consumer from ever
// running inside relayOnce's claim transaction (GO_LIVE_BLOCKERS 2.3).
//
// TOPIC PROVISIONING IS NOT DONE HERE, deliberately, even though the build plan
// bundled it into this step. provisionTopics documents itself as config-as-code
// applied out of band, never a runtime control-plane call (S23): producers
// publish to already-provisioned topics and never create them. It lives in
// provision.ts as its own one-shot command.

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    // Fail closed at startup rather than falling back to a baked-in connection
    // string (S4), and name the variable so the fix is obvious.
    throw new Error(`${name} is required and was not set`)
  }
  return value
}

function buildClients(): { clients: Map<string, TransactionalClient>; disconnect: () => Promise<void> } {
  const identity = new IdentityClient({ datasourceUrl: requireEnv('IDENTITY_DATABASE_URL') })
  const tms = new TmsClient({ datasourceUrl: requireEnv('TMS_DATABASE_URL') })
  const fulfillment = new FulfillmentClient({ datasourceUrl: requireEnv('FULFILLMENT_DATABASE_URL') })
  const analytics = new AnalyticsClient({ datasourceUrl: requireEnv('ANALYTICS_DATABASE_URL') })

  const clients = new Map<string, TransactionalClient>([
    ['identity', identity as unknown as TransactionalClient],
    ['tms', tms as unknown as TransactionalClient],
    ['fulfillment', fulfillment as unknown as TransactionalClient],
    ['analytics', analytics as unknown as TransactionalClient],
  ])

  return {
    clients,
    disconnect: async () => {
      await identity.$disconnect()
      await tms.$disconnect()
      await fulfillment.$disconnect()
      await analytics.$disconnect()
    },
  }
}

// A drain that published nothing is the normal steady state and must stay
// silent, or a 2 second poll would emit 43200 lines a day per context saying
// nothing happened. Only real work and real failures are logged.
function reportDrains(results: DrainResult[]): void {
  for (const r of results) {
    if (r.error !== undefined) {
      console.error(`[relay] ${r.context}: drain FAILED: ${r.error.message}`)
    } else if (r.published > 0) {
      console.info(`[relay] ${r.context}: published ${String(r.published)}`)
    }
  }
}

let sleepTimer: ReturnType<typeof setTimeout> | null = null
let wakeEarly: (() => void) | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    wakeEarly = resolve
    sleepTimer = setTimeout(resolve, ms)
  })
}

let stopped = false

// A signal sets the stop flag and wakes an in-progress sleep immediately, so
// shutdown does not wait out the remainder of the poll interval. It never
// interrupts a drain already in flight: that transaction is left to commit or
// roll back normally, and an at-least-once republish after an abrupt exit is
// absorbed by the consumers' inbox dedup (E6).
function requestStop(): void {
  stopped = true
  if (sleepTimer) clearTimeout(sleepTimer)
  wakeEarly?.()
}

async function main(): Promise<void> {
  assertRelayContextsAreSafe()

  const brokers = requireEnv('KAFKA_BROKERS').split(',').map((b) => b.trim()).filter((b) => b !== '')
  if (brokers.length === 0) throw new Error('KAFKA_BROKERS contained no usable broker')

  const kafka = new Kafka({ clientId: 'andpay-relay', brokers, logLevel: logLevel.ERROR })
  const producer = kafka.producer()
  await producer.connect()

  const { clients, disconnect } = buildClients()
  // Wrapped, never bare. A bare KafkaPublisher throws on a row that can never
  // be encoded, and because relayOnce claims, publishes and stamps in ONE
  // transaction, that throw rolls back the whole batch and re-claims it
  // forever. Quarantine converts that permanent failure into a DLQ write so
  // everything behind it keeps moving; a TRANSIENT failure still propagates and
  // still rolls back, which is what makes a broker outage lossless.
  const publisher = new QuarantiningPublisher(new KafkaPublisher(producer), producer, (record) => {
    console.error(
      `[relay] QUARANTINED outbox row ${record.outboxId} to ${record.topic}: ${record.reason}`,
    )
  })
  const tickSeconds = resolveTickSeconds(process.env.RELAY_TICK_SECONDS)
  const once = process.env.RELAY_ONCE === '1'

  process.on('SIGTERM', requestStop)
  process.on('SIGINT', requestStop)

  console.info(
    `[relay] draining ${String(RELAY_CONTEXTS.length)} contexts (${RELAY_CONTEXTS.map((c) => c.name).join(', ')}) ` +
      `every ${String(tickSeconds)}s${once ? ' (one-shot)' : ''}`,
  )

  try {
    await runRelay({
      once,
      tickMs: tickSeconds * 1000,
      shouldStop: () => stopped,
      sleep,
      tick: async () => {
        reportDrains(await runRelayTick({ clients, publisher, contexts: RELAY_CONTEXTS }))
      },
    })
  } finally {
    await producer.disconnect()
    await disconnect()
  }
}

main().catch((err: unknown) => {
  console.error('[relay] fatal:', err)
  process.exitCode = 1
})
