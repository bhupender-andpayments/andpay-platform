import { fromUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { stepKey, eventKey } from '@andpay/keys'
import type { Prisma } from '../generated/client/index.js'
import type { IdentityDb } from './db.js'
import { enterWriteRole } from './write-context.js'
import { aggregatorFactEnvelope, IDENTITY_AGGREGATOR_TOPIC } from './events.js'

// RE-ANNOUNCING A DEFAULT AGGREGATOR THAT WAS NEVER ANNOUNCED.
//
// 20260820120000_backfill_default_aggregators gave every pre-existing tenant
// its default aggregator in plain SQL, and said so in its own header: a
// migration cannot build an E4 envelope, so no fact was emitted and TMS never
// learned those rows existed. The migration left the projection to heal on the
// aggregator's first admin edit.
//
// That is fine right up until something reads the projection before anyone
// edits the row, which is what happened: after the GSCB merge onto code '3',
// identity held 95 aggregators and tms.aggregator_projection held 94, with the
// tenant's own default the one missing. The self-heal never fired because
// nobody had reason to edit a row that already looked correct in the portal.
//
// Identity cannot ask TMS what it is missing; that would be the cross-context
// read C4 forbids. So this announces EVERY default aggregator rather than the
// absent ones, and leans on both sides being idempotent:
//
//   - identity's own inbox gates the enqueue on stepKey(aggrId, ANNOUNCE_STEP),
//     so a second run of this function enqueues nothing at all;
//   - projectAggregatorFact upserts by aggregator id, so an announcement TMS
//     already holds rewrites the row with identical values.
//
// An announcement can therefore only make the projection more correct, never
// less, and re-running is a no-op rather than a duplicate.
//
// It deliberately does NOT co-commit an authz 6e. There is no principal here:
// this is identity restating a fact about its own data, not an operator acting
// on it, and inventing an ops verb for it would need a corpus decision.

// The inbox consumer name, identical to ops.ts's and project.ts's, so this
// shares identity's one inbox namespace (identity_write already holds grants).
const CONSUMER = 'identity'

// A CONSTANT rule-3 step, never interpolated from data. A file-supplied value
// in a key purpose is the defect commit 1011eb5 fixed; this is the same shape
// of key and must not repeat it.
const ANNOUNCE_STEP = 'announce-default'

type Tx = Prisma.TransactionClient

interface DefaultAggregatorRow {
  readonly id: string
  readonly tenant_id: string
  readonly aggregator_code: string
  readonly display_name: string
  readonly status: string
}

export interface AnnouncedAggregator {
  readonly aggrId: string
  readonly tnntId: string
  readonly aggregatorCode: string
}

export interface AnnounceDefaultAggregatorsResult {
  /** Defaults announced by THIS call, in tenant then code order. */
  readonly announced: AnnouncedAggregator[]
  /** Defaults a previous call had already announced, so this one skipped. */
  readonly alreadyAnnounced: number
}

/**
 * Announce every tenant's default aggregator as `fct.identity.aggregator.v1`,
 * once per aggregator for all time. Safe to run repeatedly; see the header.
 */
export async function announceDefaultAggregators(
  db: IdentityDb,
  args: { readonly traceId: string },
): Promise<AnnounceDefaultAggregatorsResult> {
  const announced: AnnouncedAggregator[] = []
  let alreadyAnnounced = 0

  await db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'identity_write')

    const rows = await tx.$queryRaw<DefaultAggregatorRow[]>`
      SELECT id::text AS id, tenant_id::text AS tenant_id, aggregator_code, display_name, status
      FROM aggregator
      WHERE is_default
      ORDER BY tenant_id, aggregator_code
    `

    for (const row of rows) {
      const aggrId = fromUuid('aggr', row.id)
      const tnntId = fromUuid('tnnt', row.tenant_id)
      const step = stepKey(aggrId, ANNOUNCE_STEP)

      const ran = await onceWithin(tx, CONSUMER, step, async () => {
        await enqueue(tx, {
          aggregateType: 'aggregator',
          aggregateId: aggrId,
          eventType: IDENTITY_AGGREGATOR_TOPIC,
          partitionKey: tnntId,
          payload: aggregatorFactEnvelope({
            payload: {
              aggrId,
              tnntId,
              aggregatorCode: row.aggregator_code,
              displayName: row.display_name,
              status: row.status,
              isDefault: true,
            },
            dedupKey: eventKey(step, 'identity.aggregator'),
            traceId: args.traceId,
          }),
        })
      })

      if (ran) announced.push({ aggrId, tnntId, aggregatorCode: row.aggregator_code })
      else alreadyAnnounced += 1
    }
  })

  return { announced, alreadyAnnounced }
}
