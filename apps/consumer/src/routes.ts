import type { Envelope } from '@andpay/envelope'
import { projectRowFact, type PrismaClient as IdentityClient } from '@andpay/identity-service'
import {
  projectMerchantFact,
  projectTenantFact,
  projectAggregatorFact,
  createAssignmentFromEnrollment,
  projectDispatchToCases,
  projectShipmentToCases,
  type PrismaClient as TmsClient,
} from '@andpay/tms-service'
import {
  projectDemandFact,
  onDemandAccrued,
  projectActivationToUnits,
  projectReplacementToUnits,
  consumeBatchFact,
  type AssetStore,
  type PrismaClient as FulfillmentClient,
} from '@andpay/fulfillment-service'
import {
  ingestEnvelope,
  ANALYTICS_TOPICS,
  type PrismaClient as AnalyticsClient,
} from '@andpay/analytics-service'
import { consumeAuthzAudit, type PrismaClient as AuthClient } from '@andpay/auth-service'
import { AUTHZ_AUDIT_TOPIC } from '@andpay/bus'

/**
 * The fact routes, keyed by the context that OWNS THE WRITE.
 *
 * That grouping is the whole point and it is easy to get backwards. The topic
 * namespace names the PRODUCER, the consumer is chosen by the DESTINATION:
 * `fct.tms.bank_file_row.v1` is produced by TMS and consumed by IDENTITY, which
 * is the only context allowed to write identity tables (C4). One consumer
 * process per context then matches the boundary already in the code, each with
 * its own pool and its own projections.
 *
 * The map here is COPIED from the demo pump's already-proven routing table
 * (`docs/plan/phase7_demo/harness/pump.mjs`), deliberately not re-derived: that
 * table is the version that has actually carried a real 360-row file end to
 * end.
 *
 * ALL FOUR CONTEXTS ARE WIRED (steps 2 and 3). `fct.identity.program.v1` has no
 * consumer, matching the pump, which counted it `skipped:`.
 */

export interface ConsumerRoute {
  readonly topics: readonly string[]
  readonly handle: (envelope: Envelope) => Promise<void>
  /**
   * Handler for a RAW-payload channel. Present only for `authz.audit`, the one
   * topic that carries a bare record rather than an E4 envelope, so a route
   * with this set has a `handle` that is never reached.
   */
  readonly handleRaw?: (payload: unknown) => Promise<void>
}

/**
 * Narrows the decoded envelope to the row-fact contract before handing it on.
 *
 * `runFactConsumer` yields an `Envelope` with an unknown payload, while
 * `projectRowFact` wants `Envelope<RowFactPayload>`. Checking the required
 * fields here means a malformed fact fails AT THE BOUNDARY, naming the missing
 * field, instead of surfacing as a confusing error deep inside the projection
 * (or worse, as a row written from undefined values). A bare cast would compile
 * and lie.
 */
const REQUIRED_ROW_FACT_FIELDS = [
  'bankMerchantReference',
  'displayName',
  'legalName',
  'mcc',
  'registeredAddress',
  'bankReferenceCode',
  'productType',
] as const

export function assertRowFactPayload(envelope: Envelope): void {
  const payload = envelope.payload as Record<string, unknown> | null | undefined
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`${envelope.type}: payload must be an object`)
  }
  const missing = REQUIRED_ROW_FACT_FIELDS.filter(
    (f) => typeof payload[f] !== 'string' || (payload[f] as string).length === 0,
  )
  if (missing.length > 0) {
    throw new Error(`${envelope.type}: row fact is missing ${missing.join(', ')}`)
  }
}

export function identityRoutes(db: IdentityClient): ConsumerRoute {
  return {
    topics: ['fct.tms.bank_file_row.v1'],
    handle: async (envelope: Envelope) => {
      assertRowFactPayload(envelope)
      // projectRowFact opens its own transaction, enters identity_write itself,
      // and is E6-guarded by onceWithin on the envelope dedupKey. So this
      // consumer adds NO role handling and NO dedup of its own, and
      // at-least-once redelivery from Kafka is absorbed by that guard.
      await projectRowFact(db, envelope as Parameters<typeof projectRowFact>[1])
    },
  }
}

/**
 * TMS consumes IDENTITY's facts, because TMS owns the tables they project into.
 *
 * `createAssignmentFromEnrollment` READS the merchant and tenant projections, so
 * an enrollment fact that arrives before them MUST throw. That is correct
 * behaviour, not a defect: it lands on retry.1 and succeeds once the merchant
 * fact has folded. Kafka gives no ordering between these topics anyway, because
 * they carry different partition keys, which is exactly why the ladder exists.
 *
 * DO NOT reintroduce the demo pump's dependency sort to prevent it. That sort
 * was a workaround for having no ladder, and it could only order facts WITHIN
 * one claimed batch, so a merchant and its enrollment straddling a batch
 * boundary still failed. It is dead weight now (task B-2).
 */
export function tmsRoutes(db: TmsClient): ConsumerRoute {
  return {
    topics: [
      'fct.identity.merchant.v1',
      'fct.identity.tenant.v1',
      'fct.identity.aggregator.v1',
      'fct.identity.enrollment.v1',
      // D-24 (T6.5): a damage case moves to In Progress when the replacement
      // it answers enters the pipeline. That is a FULFILLMENT event, and TMS
      // learns it the only sanctioned way (T7): by consuming the fact it
      // already publishes. No new topic, no cross-context read.
      'fct.fulfillment.dispatch.v1',
      // B4 (D-24, DP-11): a COLLATERAL replacement's case closes when its
      // consignment is DELIVERED. Same sanctioned integration as the dispatch
      // fact above: an existing topic consumed, never a cross-context read.
      'fct.fulfillment.shipment.v1',
    ],
    handle: async (envelope: Envelope) => {
      switch (envelope.type) {
        case 'fct.identity.merchant.v1':
          await projectMerchantFact(db, envelope as Parameters<typeof projectMerchantFact>[1])
          return
        case 'fct.fulfillment.dispatch.v1':
          await projectDispatchToCases(db, envelope as Parameters<typeof projectDispatchToCases>[1])
          return
        case 'fct.fulfillment.shipment.v1':
          await projectShipmentToCases(db, envelope as Parameters<typeof projectShipmentToCases>[1])
          return
        case 'fct.identity.tenant.v1':
          await projectTenantFact(db, envelope as Parameters<typeof projectTenantFact>[1])
          return
        case 'fct.identity.aggregator.v1':
          await projectAggregatorFact(db, envelope as Parameters<typeof projectAggregatorFact>[1])
          return
        case 'fct.identity.enrollment.v1':
          await createAssignmentFromEnrollment(db, envelope as Parameters<typeof createAssignmentFromEnrollment>[1])
          return
        default:
          // Never silently ignore. A subscribed topic with no case is a wiring
          // bug, and dropping it would lose a fact with no trace.
          throw new Error(`tms consumer received an unrouted topic: ${envelope.type}`)
      }
    },
  }
}

interface DemandPayload {
  tnntId: string
  progId: string
  // R-7 (16 Aug 2026): the row's bank reference code, consumed by the per-bank
  // LOT_SIZE evaluation. Optional here because the accrual must keep working
  // for a fact without it (onDemandAccrued's own default is the pool-wide
  // path), not because the fact ever omits it today.
  bankReferenceCode: string
}

function demandTargetOf(envelope: Envelope): DemandPayload {
  const p = envelope.payload as Partial<DemandPayload> | null
  if (typeof p?.tnntId !== 'string' || typeof p.progId !== 'string') {
    throw new Error(`${envelope.type}: demand fact is missing tnntId or progId`)
  }
  return {
    tnntId: p.tnntId,
    progId: p.progId,
    bankReferenceCode: typeof p.bankReferenceCode === 'string' ? p.bankReferenceCode : '',
  }
}

/**
 * FULFILLMENT consumes TMS's assignment facts plus its own batch fact.
 *
 * The batch fact is what makes a batch DISPATCHABLE: `consumeBatchFact` composes
 * the collateral and emits `fct.fulfillment.dispatch.v1`, which is what tells
 * analytics which assignments belong to which shipment. Without it,
 * `dispatch_row` never learns its shpt_id, the later DELIVERED fact has no row
 * to stamp, and the ops activation route keeps answering "not-delivered" for a
 * parcel that demonstrably arrived.
 */
export function fulfillmentRoutes(db: FulfillmentClient, assetStore: AssetStore): ConsumerRoute {
  return {
    topics: [
      'fct.tms.assignment.v1',
      'fct.tms.assignment.activated.v1',
      'fct.tms.assignment.replacement_raised.v1',
      'fct.fulfillment.batch.v1',
    ],
    handle: async (envelope: Envelope) => {
      switch (envelope.type) {
        case 'fct.tms.assignment.v1': {
          const res = await projectDemandFact(db, envelope as Parameters<typeof projectDemandFact>[1])
          if (res.deduped) return
          const { tnntId, progId, bankReferenceCode } = demandTargetOf(envelope)
          // THE DEDUP KEY IS THE DEMAND FACT'S OWN, exactly as onDemandAccrued
          // documents ("epoch = triggerDedupKey ... so a redelivered demand
          // fact can never double-trigger a LOT_SIZE batch"). The demo pump
          // passed `pump:<tnnt>:<prog>:<Date.now()>`, which is unique per call
          // and therefore defeats that guarantee outright. Do not copy it.
          //
          // Called per message rather than batched: it is idempotent by that
          // key, so the pump's accrual map is unnecessary here.
          await onDemandAccrued(db, tnntId, progId, envelope.dedupKey, envelope.traceId ?? envelope.dedupKey, bankReferenceCode)
          return
        }
        case 'fct.tms.assignment.activated.v1':
          await projectActivationToUnits(db, envelope as Parameters<typeof projectActivationToUnits>[1])
          return
        case 'fct.tms.assignment.replacement_raised.v1':
          await projectReplacementToUnits(db, envelope as Parameters<typeof projectReplacementToUnits>[1])
          return
        case 'fct.fulfillment.batch.v1':
          await consumeBatchFact(db, envelope as Parameters<typeof consumeBatchFact>[1], assetStore)
          return
        default:
          throw new Error(`fulfillment consumer received an unrouted topic: ${envelope.type}`)
      }
    },
  }
}

/**
 * ANALYTICS is a SECOND consumer of most topics, not an alternative to the
 * domain one. Its own consumer group is what makes that natural on Kafka: the
 * demo pump had to call `ingestEnvelope` inline after each domain handler,
 * which coupled the two and meant a domain failure could skip the analytics
 * write.
 *
 * It feeds `analytics.dispatch_row`, and `dispatch_row.delivery_date` is the
 * gate the ops activation route reads.
 */
export function analyticsRoutes(db: AnalyticsClient): ConsumerRoute {
  return {
    topics: [...ANALYTICS_TOPICS],
    handle: async (envelope: Envelope) => {
      await ingestEnvelope(db, envelope)
    },
  }
}

/**
 * AUTH: the authorization-decision ledger (6e).
 *
 * Every context emits `authz.audit` records into its own outbox, the relay
 * publishes them, and until now NOTHING read them back: the hash-chained
 * ledger in `auth.authz_audit` was simply not being appended, so a permission
 * denial left no durable trace. Measured live during D-9: a real 403 produced
 * no ledger row.
 *
 * Bhupender asked for these to be kept in the database "so we can know who is
 * trying to access the things not allowed to", which is what this route does.
 *
 * THE ONE RAW CHANNEL. `authz.audit` carries the bare record `{id, ...record}`,
 * not an E4 envelope (see @andpay/bus topics.ts), so it arrives via `handleRaw`.
 * `consumeAuthzAudit` dedups on the DELIVERED `payload.id`, so a redelivery
 * appends nothing and the chain cannot fork.
 *
 * NOT the same thing as A-7. This drains the audit records the OTHER four
 * contexts produce, which is ordinary bus traffic. A-7 is about draining
 * `auth`'s OWN outbox, which carries credential-shaped facts and still needs an
 * S4 decision. That stays open.
 */
export function authRoutes(db: AuthClient): ConsumerRoute {
  return {
    topics: [AUTHZ_AUDIT_TOPIC],
    handle: async () => {
      // Unreachable: isEnvelopeTopic routes this channel to handleRaw. Kept so
      // a future change that starts sending envelopes here fails loudly instead
      // of silently writing nothing.
      throw new Error(`${AUTHZ_AUDIT_TOPIC} is a raw-payload channel and must be handled by handleRaw`)
    },
    handleRaw: async (payload: unknown) => {
      await consumeAuthzAudit(db, payload as Parameters<typeof consumeAuthzAudit>[1])
    },
  }
}

/** The consumer group for a context. Ruling A-6.3: context plus schema version. */
export function groupIdFor(context: string): string {
  return `andpay.${context}.v1`
}
