import type { Envelope } from '@andpay/envelope'
import { projectRowFact, type PrismaClient as IdentityClient } from '@andpay/identity-service'

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
 * STEP 2 SHIPS IDENTITY ONLY. tms, fulfillment and analytics are step 3.
 * Their routes, from the same pump table, will be:
 *   tms          fct.identity.merchant.v1     -> projectMerchantFact
 *                fct.identity.tenant.v1       -> projectTenantFact
 *                fct.identity.enrollment.v1   -> createAssignmentFromEnrollment
 *   fulfillment  fct.tms.assignment.v1        -> projectDemandFact (plus accrual)
 *                fct.tms.assignment.activated.v1        -> projectActivationToUnits
 *                fct.tms.assignment.replacement_raised.v1 -> projectReplacementToUnits
 *                fct.fulfillment.batch.v1     -> consumeBatchFact
 *   analytics    the nine ANALYTICS_TOPICS    -> ingestEnvelope
 *
 * NOTE for step 3: `createAssignmentFromEnrollment` READS the merchant and
 * tenant projections, so an enrollment fact arriving before them MUST throw.
 * That is correct behaviour, not a bug: it lands on retry.1 and succeeds once
 * the merchant fact has folded. Do NOT reintroduce the pump's dependency sort
 * to prevent it. Kafka gives no ordering between those topics anyway, because
 * they carry different partition keys.
 */

export interface ConsumerRoute {
  readonly topics: readonly string[]
  readonly handle: (envelope: Envelope) => Promise<void>
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

/** The consumer group for a context. Ruling A-6.3: context plus schema version. */
export function groupIdFor(context: string): string {
  return `andpay.${context}.v1`
}
