import { Kafka, logLevel } from 'kafkajs'
import { runFactConsumer } from '@andpay/bus'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { identityRoutes, groupIdFor, type ConsumerRoute } from './routes.js'

// The per-context fact consumer (relay plan step 2).
//
// ONE PROCESS PER CONTEXT is the ratified shape, and this is one image run once
// per context via CONSUMER_CONTEXT, not one image consuming everything. Each
// process then owns exactly one context's pool and writes only that context's
// tables, which is the C4 boundary already present in the code.
//
// The relay (apps/relay) publishes; this consumes. Keeping them separate is
// what stops a slow consumer from ever running inside relayOnce's claim
// transaction (GO_LIVE_BLOCKERS 2.3).
//
// STEP 2 SHIPS IDENTITY ONLY. Asking for another context fails loudly rather
// than starting a process that silently consumes nothing.

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required and was not set`)
  }
  return value
}

interface Built {
  route: ConsumerRoute
  disconnect: () => Promise<void>
}

function buildContext(context: string): Built {
  if (context === 'identity') {
    const db = new IdentityClient({ datasourceUrl: requireEnv('IDENTITY_DATABASE_URL') })
    return { route: identityRoutes(db), disconnect: () => db.$disconnect() }
  }
  throw new Error(
    `CONSUMER_CONTEXT="${context}" is not built yet. Step 2 ships identity only; tms, fulfillment and analytics are step 3.`,
  )
}

async function main(): Promise<void> {
  const context = requireEnv('CONSUMER_CONTEXT')
  const brokers = requireEnv('KAFKA_BROKERS').split(',').map((b) => b.trim()).filter((b) => b !== '')
  if (brokers.length === 0) throw new Error('KAFKA_BROKERS contained no usable broker')

  const { route, disconnect } = buildContext(context)
  const groupId = groupIdFor(context)

  // fromBeginning is passed EXPLICITLY (ruling A-6.3). runFactConsumer defaults
  // it to TRUE, so leaving it off means a new or renamed group replays the
  // entire topic from offset 0 on first start. That is safe, since every
  // consumer is E6-guarded, but it is a long and baffling startup nobody asked
  // for. CONSUMER_FROM_BEGINNING=1 opts INTO a deliberate replay, which is the
  // supported way to rebuild a projection from the log.
  const fromBeginning = process.env.CONSUMER_FROM_BEGINNING === '1'

  const kafka = new Kafka({ clientId: `andpay-consumer-${context}`, brokers, logLevel: logLevel.ERROR })

  console.info(
    `[consumer:${context}] group ${groupId}, topics ${route.topics.join(', ')}` +
      `${fromBeginning ? ', REPLAYING FROM THE START OF EACH TOPIC' : ''}`,
  )

  const handle = await runFactConsumer(kafka, {
    groupId,
    topics: [...route.topics],
    fromBeginning,
    onEnvelope: async (envelope) => {
      try {
        await route.handle(envelope)
      } catch (err: unknown) {
        // Rethrow after naming the fact. kafkajs does NOT commit the offset for
        // a throwing message, so it is retried rather than lost. The retry
        // LADDER (retry.1/2/3 then dlq) is step 4; until it exists a genuinely
        // poison message retries indefinitely, which is loud rather than
        // silent, and is the right failure mode of the two.
        console.error(
          `[consumer:${context}] ${envelope.type} dedupKey=${envelope.dedupKey} failed: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
        throw err
      }
    },
  })

  const stop = (): void => {
    void (async () => {
      await handle.stop()
      await disconnect()
    })()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

main().catch((err: unknown) => {
  console.error('[consumer] fatal:', err)
  process.exitCode = 1
})
