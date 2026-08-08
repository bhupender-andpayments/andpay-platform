import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import type { OutboxMessage, PublisherPort } from '@andpay/outbox'
import { PrismaClient as FulfillmentClient } from '@andpay/fulfillment-service'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { runRelayTick } from '../src/tick.js'
import type { TransactionalClient } from '../src/role-client.js'
import type { RelayContext } from '../src/contexts.js'

// The relay drain against the REAL databases under the REAL infra roles.
//
// This is the assertion that matters most right now: the only DB login role
// today is SUPERUSER + BYPASSRLS (task E-3), so a relay that silently ran as the
// owner would look identical to one correctly wearing `<ctx>_relay` until the
// day that login role is fixed, at which point it would break in production.
// Every drain below reads current_user back from inside the same transaction.

const fulfillmentDb = new FulfillmentClient({
  datasourceUrl:
    process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment',
})
const identityDb = new IdentityClient({
  datasourceUrl:
    process.env.IDENTITY_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity',
})

const CONTEXTS: readonly RelayContext[] = [
  { name: 'fulfillment', role: 'fulfillment_relay', urlEnv: 'FULFILLMENT_DATABASE_URL' },
  { name: 'identity', role: 'identity_relay', urlEnv: 'IDENTITY_DATABASE_URL' },
]

const clients = new Map<string, TransactionalClient>([
  ['fulfillment', fulfillmentDb as unknown as TransactionalClient],
  ['identity', identityDb as unknown as TransactionalClient],
])

class CapturingPublisher implements PublisherPort {
  readonly published: OutboxMessage[] = []
  async publish(messages: OutboxMessage[]): Promise<void> {
    this.published.push(...messages)
  }
}

class ExplodingPublisher implements PublisherPort {
  async publish(): Promise<void> {
    throw new Error('broker unreachable')
  }
}

// A REAL E4 envelope (packages/envelope REQUIRED_STRINGS: id, type, timestamp,
// subject, dedupKey, traceId, plus an integer version and a payload).
//
// These tests use a fake publisher that does not validate, so a wrong shape
// would still pass. It is spelled correctly anyway: a fixture is documentation,
// and one that teaches a shape KafkaPublisher would reject at runtime is worse
// than no fixture. Proven against the real broker during step-1 verification.
function envelope(subject: string): string {
  return JSON.stringify({
    id: `00000000-0000-4000-8000-${subject.slice(-12).padStart(12, '0')}`,
    type: 'fct.fulfillment.batch.v1',
    version: 1,
    timestamp: '2026-08-08T18:00:00.000Z',
    subject,
    dedupKey: `dedup-${subject}`,
    traceId: `trace-${subject}`,
    payload: { probe: true },
  })
}

beforeEach(async () => {
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE outbox')
  await identityDb.$executeRawUnsafe('TRUNCATE outbox')
})

afterAll(async () => {
  await fulfillmentDb.$disconnect()
  await identityDb.$disconnect()
})

/** Unpublished rows for ONE aggregate id, never a table-wide count. */
async function unpublishedCount(aggregateId: string): Promise<number> {
  const rows = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM outbox WHERE published_at IS NULL AND aggregate_id = ${aggregateId}
  `
  return Number(rows[0]!.n)
}

async function seedFulfillment(aggregateId: string): Promise<void> {
  await fulfillmentDb.$executeRaw`
    INSERT INTO outbox (aggregate_type, aggregate_id, event_type, partition_key, payload)
    VALUES ('batch', ${aggregateId}, 'fct.fulfillment.batch.v1', ${aggregateId}, ${envelope(aggregateId)}::jsonb)
  `
}

describe('runRelayTick', () => {
  it('drains a context and stamps published_at', async () => {
    await seedFulfillment('btch_relay_1')
    const publisher = new CapturingPublisher()

    const results = await runRelayTick({ clients, publisher, contexts: CONTEXTS })

    expect(results.find((r) => r.context === 'fulfillment')?.published).toBe(1)
    expect(publisher.published).toHaveLength(1)
    // Asserted on THIS row, never a global unpublished count. The demo pump
    // (docs/plan/phase7_demo/harness/pump.mjs) calls the same relayOnce against
    // the same table every 3 seconds, so a global count is a race against
    // whatever else is running on the machine.
    expect(await unpublishedCount('btch_relay_1')).toBe(0)
  })

  it('runs the drain as <ctx>_relay, NOT as the owner', async () => {
    await seedFulfillment('btch_relay_role')
    // Read current_user from inside the drain's own transaction by wrapping the
    // client one layer further out. If withRole were dropped, this reads the
    // superuser login role and the assertion fails.
    let seen: string | null = null
    const spy: TransactionalClient = {
      $transaction: (fn) =>
        (fulfillmentDb as unknown as TransactionalClient).$transaction(async (tx) => {
          const out = await fn(tx)
          const who = await tx.$queryRawUnsafe<{ u: string }[]>('SELECT current_user AS u')
          seen = who[0]!.u
          return out
        }),
    }
    await runRelayTick({
      clients: new Map([['fulfillment', spy]]),
      publisher: new CapturingPublisher(),
      contexts: [CONTEXTS[0]!],
    })
    expect(seen).toBe('fulfillment_relay')
  })

  it('leaves rows UNPUBLISHED when the broker fails, so nothing is lost', async () => {
    await seedFulfillment('btch_relay_fail')
    const results = await runRelayTick({
      clients,
      publisher: new ExplodingPublisher(),
      contexts: [CONTEXTS[0]!],
    })
    expect(results[0]?.error?.message).toContain('broker unreachable')
    // The stamp happens inside the same transaction as the publish, so a failed
    // publish rolls the whole claim back and the row is retried next tick.
    expect(await unpublishedCount('btch_relay_fail')).toBe(1)
  })

  it('one context failing does NOT stop the others', async () => {
    await seedFulfillment('btch_relay_isolated')
    const publisher = new CapturingPublisher()
    const results = await runRelayTick({
      clients: new Map([
        ['fulfillment', clients.get('fulfillment')!],
        // A context with no client stands for any per-context failure.
        ['identity', undefined as unknown as TransactionalClient],
      ]),
      publisher,
      contexts: CONTEXTS,
    })
    expect(results.find((r) => r.context === 'fulfillment')?.published).toBe(1)
    expect(results.find((r) => r.context === 'identity')?.error).toBeDefined()
  })

  it('an empty outbox is a silent no-op, not an error', async () => {
    const results = await runRelayTick({ clients, publisher: new CapturingPublisher(), contexts: CONTEXTS })
    expect(results.every((r) => r.published === 0 && r.error === undefined)).toBe(true)
  })

  it('publishes the outbox row key as the partition key (E5 ordering)', async () => {
    await seedFulfillment('btch_relay_key')
    const publisher = new CapturingPublisher()
    await runRelayTick({ clients, publisher, contexts: [CONTEXTS[0]!] })
    expect(publisher.published[0]?.partitionKey).toBe('btch_relay_key')
    expect(publisher.published[0]?.eventType).toBe('fct.fulfillment.batch.v1')
  })
})
