import { describe, it, expect } from 'vitest'
import { ANALYTICS_TOPICS } from '@andpay/analytics-service'
import { SOUNDBOX_TOPICS } from '@andpay/bus'
import {
  identityRoutes,
  tmsRoutes,
  fulfillmentRoutes,
  analyticsRoutes,
  groupIdFor,
} from '../src/routes.js'
import { ladderTopicsFor } from '../src/ladder.js'

// Steps 2 and 3: the whole routing table, asserted as a TABLE rather than one
// handler at a time. The projections themselves are already covered by each
// service's own suite; what is new and worth pinning is that every fact has
// exactly one home, and that the map matches the demo pump's proven routing.

const anyDb = {} as never
const anyStore = {} as never

const ROUTES = {
  identity: identityRoutes(anyDb),
  tms: tmsRoutes(anyDb),
  fulfillment: fulfillmentRoutes(anyDb, anyStore),
  analytics: analyticsRoutes(anyDb),
}

describe('the routing table matches the pump table it was copied from', () => {
  it('routes each context to the topics that pump.mjs proved', () => {
    expect(ROUTES.identity.topics).toEqual(['fct.tms.bank_file_row.v1'])
    // D-24 (T6.5): TMS gained fct.fulfillment.dispatch.v1, its FIRST subscription
    // to another context's fact. A damage case moves to In Progress when the
    // replacement it answers enters the pipeline, which only fulfillment sees;
    // consuming the existing fact is the sanctioned way to learn it (T7), and
    // the alternative would have been a cross-context table read (C4 forbids it).
    //
    // B4 (D-24, DP-11): fct.fulfillment.shipment.v1 joined it for the other end
    // of the same lifecycle. DELIVERED is a COLLATERAL replacement's terminal,
    // so the case closes off the shipment fact, by the identical T7 reasoning.
    expect([...ROUTES.tms.topics].sort()).toEqual([
      'fct.fulfillment.dispatch.v1',
      'fct.fulfillment.shipment.v1',
      'fct.identity.aggregator.v1',
      'fct.identity.enrollment.v1',
      'fct.identity.merchant.v1',
      'fct.identity.tenant.v1',
    ])
    expect([...ROUTES.fulfillment.topics].sort()).toEqual([
      'fct.fulfillment.batch.v1',
      'fct.tms.assignment.activated.v1',
      'fct.tms.assignment.replacement_raised.v1',
      'fct.tms.assignment.v1',
    ])
    expect(ROUTES.analytics.topics).toEqual(ANALYTICS_TOPICS)
  })

  it('gives each context its own group id', () => {
    const groups = Object.keys(ROUTES).map(groupIdFor)
    expect(groups).toEqual([
      'andpay.identity.v1',
      'andpay.tms.v1',
      'andpay.fulfillment.v1',
      'andpay.analytics.v1',
    ])
    expect(new Set(groups).size).toBe(groups.length)
  })
})

describe('domain ownership', () => {
  it('gives every DOMAIN fact exactly one owning context', () => {
    // Analytics is excluded on purpose: it is a SECOND consumer of most topics,
    // not an alternative to the domain one, which is exactly why it has its own
    // group. Two DOMAIN consumers of one topic would be a real defect: both
    // would write, and which won would depend on timing.
    const domain = [ROUTES.identity, ROUTES.tms, ROUTES.fulfillment].flatMap((r) => [...r.topics])
    expect(new Set(domain).size, 'a topic is claimed by two domain consumers').toBe(domain.length)
  })

  it('consumes only topics that are actually provisioned', () => {
    // A subscription to a topic nobody provisions is a silent no-op: the
    // consumer looks healthy and the facts never arrive.
    const provisioned = new Set(SOUNDBOX_TOPICS.map((t) => t.name))
    for (const [context, route] of Object.entries(ROUTES)) {
      for (const topic of route.topics) {
        expect(provisioned.has(topic), `${context} subscribes to unprovisioned ${topic}`).toBe(true)
      }
    }
  })

  it('leaves fct.identity.program.v1 unconsumed, matching the pump', () => {
    // The pump counted this `skipped:`. Recorded as a deliberate gap so nobody
    // reads its absence as an oversight.
    const all = Object.values(ROUTES).flatMap((r) => [...r.topics])
    expect(all).not.toContain('fct.identity.program.v1')
  })
})

describe('unrouted topics fail loudly', () => {
  it('throws rather than silently dropping a fact it does not recognise', async () => {
    // Silently ignoring would lose a fact with no trace. Throwing sends it to
    // the ladder and eventually the DLQ, where a human can see it.
    const envelope = { type: 'fct.something.unknown.v1', dedupKey: 'k' } as never
    await expect(ROUTES.tms.handle(envelope)).rejects.toThrow(/unrouted topic/)
    await expect(ROUTES.fulfillment.handle(envelope)).rejects.toThrow(/unrouted topic/)
  })
})

describe('ladder subscriptions', () => {
  it('subscribes each context to its base topics and every rung, never a DLQ', () => {
    for (const route of Object.values(ROUTES)) {
      const subs = ladderTopicsFor(route.topics)
      expect(subs.length).toBe(route.topics.length * 4)
      expect(subs.some((t) => t.endsWith('.dlq'))).toBe(false)
    }
  })
})
