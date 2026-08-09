import { Kafka, logLevel } from 'kafkajs'
import { runFactConsumer } from '@andpay/bus'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as FulfillmentClient, FilesystemAssetStore } from '@andpay/fulfillment-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { PrismaClient as AuthClient } from '@andpay/auth-service'
import { identityRoutes, tmsRoutes, fulfillmentRoutes, analyticsRoutes, authRoutes, groupIdFor, type ConsumerRoute } from './routes.js'
import { withLadder, withRawLadder, ladderTopicsFor } from './ladder.js'

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
// All FIVE contexts are wired (the four fact contexts plus auth, which appends
// the 6e authorization-decision ledger). An unknown CONSUMER_CONTEXT fails
// loudly rather than starting a process that silently consumes nothing.

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
  switch (context) {
    case 'identity': {
      const db = new IdentityClient({ datasourceUrl: requireEnv('IDENTITY_DATABASE_URL') })
      return { route: identityRoutes(db), disconnect: () => db.$disconnect() }
    }
    case 'tms': {
      const db = new TmsClient({ datasourceUrl: requireEnv('TMS_DATABASE_URL') })
      return { route: tmsRoutes(db), disconnect: () => db.$disconnect() }
    }
    case 'fulfillment': {
      const db = new FulfillmentClient({ datasourceUrl: requireEnv('FULFILLMENT_DATABASE_URL') })
      // GO-LIVE BLOCKER E-5 is still OPEN: production needs the S3 adapter,
      // and this filesystem adapter is not it (no durability guarantee beyond
      // the local disk, no lifecycle policy, no cross-host story).
      //
      // What it DOES fix is the half of E-5 that was breaking the running
      // system rather than a future one. consumeBatchFact renders collateral
      // into this store, and with the in-memory adapter those bytes lived in
      // THIS process's memory, so the ops edge (a different process) could not
      // serve what this one rendered: every collateral download answered 500
      // while composed_artifact looked perfectly healthy. Both processes now
      // resolve the same directory, so a reference minted here is readable
      // there. See storage/fs-asset-store.ts.
      const assetStore = new FilesystemAssetStore()
      return { route: fulfillmentRoutes(db, assetStore), disconnect: () => db.$disconnect() }
    }
    case 'analytics': {
      const db = new AnalyticsClient({ datasourceUrl: requireEnv('ANALYTICS_DATABASE_URL') })
      return { route: analyticsRoutes(db), disconnect: () => db.$disconnect() }
    }
    case 'auth': {
      // The 6e ledger consumer. It appends every authorization decision the
      // other contexts emit to auth.authz_audit, which is what makes a
      // permission denial durable and answerable ("who tried to reach what").
      // Before this, the chain was simply never appended.
      const db = new AuthClient({ datasourceUrl: requireEnv('AUTH_DATABASE_URL') })
      return { route: authRoutes(db), disconnect: () => db.$disconnect() }
    }
    default:
      throw new Error(
        `CONSUMER_CONTEXT="${context}" is not a context. Expected one of: identity, tms, fulfillment, analytics, auth.`,
      )
  }
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

  // The ladder needs a producer of its own: a failed message is republished one
  // rung up rather than rethrown. Rethrowing is what jams a partition, because
  // kafkajs never commits the offset for a throwing message and redelivers the
  // same one forever.
  const producer = kafka.producer()
  await producer.connect()

  const handle = await runFactConsumer(kafka, {
    groupId,
    // Base topic plus every retry rung, never the DLQ.
    topics: ladderTopicsFor(route.topics),
    fromBeginning,
    onEnvelope: withLadder({
      producer,
      handle: route.handle,
      onRetry: (i) => {
        console.warn(
          `[consumer:${context}] ${i.dedupKey} -> ${i.nextTopic}: ${i.reason}`,
        )
      },
      onDeadLetter: (i) => {
        // The signal a human acts on. A message here is no longer being
        // retried, so silence would mean a fact quietly ceased to exist.
        console.error(
          `[consumer:${context}] DEAD-LETTERED ${i.dedupKey} to ${i.topic}: ${i.reason}`,
        )
      },
    }),
    // Only the auth context sets handleRaw, for the one non-envelope channel.
    // Passed through the SAME ladder, so a failing audit append moves a rung
    // instead of jamming the partition, exactly like every other consumer.
    ...(route.handleRaw
      ? {
          onRawPayload: withRawLadder({
            producer,
            handle: route.handleRaw,
            onRetry: (i) => {
              console.warn(`[consumer:${context}] ${i.dedupKey} -> ${i.nextTopic}: ${i.reason}`)
            },
            onDeadLetter: (i) => {
              console.error(`[consumer:${context}] DEAD-LETTERED ${i.dedupKey} to ${i.topic}: ${i.reason}`)
            },
          }),
        }
      : {}),
  })

  const stop = (): void => {
    void (async () => {
      await handle.stop()
      await producer.disconnect()
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
