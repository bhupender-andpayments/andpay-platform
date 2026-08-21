import { enqueue, onceWithin } from '@andpay/outbox'
import { buildAuthzAuditEvent, type AuthzAuditRecord } from '@andpay/audit'
import { instanceKey, eventKey } from '@andpay/keys'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { TmsDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteRole, enterWriteScope } from './write-context.js'
import { emitDemandFact, type DispatchGroup } from './assignment.js'
import { replacementRaisedFactEnvelope, TMS_REPLACEMENT_RAISED_TOPIC } from './events.js'
import { OpsClientError } from './ops.js'

// D-26, D-27, D-28 (Damage and Replacement Workflow, 16 Aug 2026): the Flag
// Damage write. The damage file is gone (D-25); the operator IS the resolver
// now. They flag a specific dispatch leg, which is already one W-5 consignment
// (SOUNDBOX or COLLATERAL), so the child inherits that leg's dispatch_group by
// construction (DP-2) and the old O-1 resolution seam has no question left to
// answer.
//
// The mint itself is the same shape the file ingest used: a non-billable child
// referencing its parent via replacement_of, the replacement_raised linkage
// fact, the demand fact (so the child enters the normal pool with zero
// special-casing downstream), and the parent's move to replacement-raised, all
// in one transaction with the co-committed ALLOW 6e (spec 10c CC-1).

// The cap on the operator's remarks, matching MAX_OPS_REMARKS_LENGTH in ops.ts
// and the trigger-note and hold-reason caps elsewhere: long enough for a real
// explanation, short enough that the column is a note and not a document store.
const MAX_REMARKS_LENGTH = 500

// DP-2: an item quantity on a COLLATERAL leg is a small non-negative integer.
const MAX_ITEM_COUNT = 99

export interface FlagDamageArgs {
  asgnId: string // wire asgn_ id of the flagged dispatch leg
  reasonCode: string // damage_reason.code, must be active
  remarks: string // required, trimmed non-empty, max 500
  standeeCount?: number // COLLATERAL only, int 0..99
  stickerCount?: number // COLLATERAL only, int 0..99
  clientKey: string // Idempotency-Key
  actorId: string // claim.sub, never a body field
  traceId: string
}

export interface FlagDamageResult {
  childAsgnId: string
  caseStatus: 'Open'
}

// The parent snapshot the child clones, the same column set the file mint read.
interface ParentRow {
  id: string
  merchant_id: string
  program_id: string
  tenant_id: string
  merchant_display_name: string
  merchant_legal_name: string
  merchant_mcc: string
  bank_reference_code: string
  bank_display_name: string
  ship_to_address: string
  qr_value: string
  vpa_value: string
  contact_name: string | null
  mobile: string | null
  branch_code: string | null
  dispatch_group: DispatchGroup
  /** The merchant-request identity this leg belongs to; the child derives from it. */
  source_event_id: string
}

function requireItemCount(value: number | undefined, name: string): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < 0 || value > MAX_ITEM_COUNT) {
    throw new OpsClientError('invalid', `${name} must be an integer between 0 and ${MAX_ITEM_COUNT}`)
  }
}

// The class-3 ops flag-damage write (D-26/D-27/D-28). Modeled on
// updateDamageCaseStatusOps: role entry FIRST (spec 10d landmine), client
// conditions validated and thrown BEFORE onceWithin, enterWriteScope inside
// the deduped effect right before the writes it guards, ALLOW 6e co-committed
// in the SAME tx (spec 10c CC-1), IDs and enum tokens only on the audit (the
// free-text remarks stay on the domain row, S7/DD1).
export async function flagDamageOps(db: TmsDb, args: FlagDamageArgs): Promise<FlagDamageResult> {
  // Field-shape validation runs before the transaction, matching the
  // create-path idiom (createDamageReasonOps): a request that can never
  // succeed should not cost a transaction.
  const remarks = args.remarks.trim()
  if (remarks === '') {
    throw new OpsClientError('invalid', 'remarks are required')
  }
  if (remarks.length > MAX_REMARKS_LENGTH) {
    throw new OpsClientError('invalid', `remarks must be ${MAX_REMARKS_LENGTH} characters or fewer`)
  }
  requireItemCount(args.standeeCount, 'standeeCount')
  requireItemCount(args.stickerCount, 'stickerCount')
  const parentUuid = toUuid(args.asgnId)


  return db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'tms_write')

    // The parent is the flagged leg; its program is the scope (D99, resolved
    // server-side from the target aggregate, never from the body).
    const parents = await tx.$queryRaw<ParentRow[]>`
      SELECT id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
             bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value,
             contact_name, mobile, branch_code, dispatch_group, source_event_id
      FROM assignment WHERE id = ${parentUuid}::uuid
    `
    if (parents.length !== 1) {
      throw new OpsClientError('not-found', 'no such dispatch')
    }
    const parent = parents[0]!

    // THE CHILD'S REQUEST KEY IS DERIVED FROM THE PARENT'S (DAMAGE.md).
    //
    // source_event_id is the platform's merchant-request identity: both legs of
    // one bank-file row share it, the pool GROUPS BY it, and the minimum-lot
    // batching gate counts DISTINCT values of it. A replacement used to get a
    // fresh random key (`ops-flag|<clientKey>`), which broke all three at once.
    // Flagging a merchant's soundbox and their standee produced two unrelated
    // request rows in the pool for what was one request, and counted 2 toward a
    // gate the original counted 1 for.
    //
    // Deriving it from the parent's key puts both replacement legs back in one
    // request, exactly like the original.
    //
    // THE GENERATION SUFFIX IS NOT DECORATION. Without it a second round of
    // damage on the same leg would reuse the same (source_event_id,
    // dispatch_group) pair and be swallowed silently by the ON CONFLICT DO
    // NOTHING below, so the operator would get a success and no replacement.
    // The generation is the depth of the chain the parent already sits on.
    const depth = await tx.$queryRaw<{ n: bigint }[]>`
      WITH RECURSIVE up AS (
        SELECT id, replacement_of FROM assignment WHERE id = ${parentUuid}::uuid
        UNION ALL
        SELECT a.id, a.replacement_of FROM assignment a JOIN up u ON a.id = u.replacement_of
      )
      SELECT count(*) AS n FROM up
    `
    // The parent itself is row 1, so its first replacement is generation 1.
    const generation = Number(depth[0]?.n ?? 1n)
    // The ROOT request's key, never the parent's own derived one, so a third
    // generation reads `...|g3` rather than `...|g2|g3`.
    const rootKey = parent.source_event_id.replace(/^ops-flag\|/, '').replace(/\|g\d+$/, '')
    const sourceEventId = `ops-flag|${rootKey}|g${String(generation)}`




    // DP-2: the leg decides the product columns. A SOUNDBOX leg is quantity
    // one by definition (D-27 and D-6), so any count input is a caller error
    // rather than a value to silently drop. A COLLATERAL leg needs the
    // operator's counts, at least one item in total.
    let soundbox: boolean
    let standeeCount: number
    let stickerCount: number
    if (parent.dispatch_group === 'SOUNDBOX') {
      if (args.standeeCount !== undefined || args.stickerCount !== undefined) {
        throw new OpsClientError('invalid', 'a soundbox dispatch takes no item counts')
      }
      soundbox = true
      standeeCount = 0
      stickerCount = 0
    } else {
      soundbox = false
      standeeCount = args.standeeCount ?? 0
      stickerCount = args.stickerCount ?? 0
      if (standeeCount + stickerCount < 1) {
        throw new OpsClientError('invalid', 'a collateral flag must replace at least one item')
      }
    }

    // DP-5: the reason is the master CODE, validated active. The file ingest
    // matched free bank text by label; the operator picks from the master, so
    // the code is the honest value and it is compared exactly, never fuzzily.
    const reasons = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM damage_reason WHERE active = true AND code = ${args.reasonCode}
    `
    if (reasons.length !== 1) {
      throw new OpsClientError('invalid', 'reasonCode must name an active damage reason')
    }

    // DP-3's one-live-case guard USED TO BE HERE and is now unreachable: the
    // tip gate above is strictly stronger, refusing a parent with ANY child
    // rather than only one whose case is still open. Kept as a note instead of
    // as dead code, because DP-3 said the opposite (re-flagging a parent was
    // allowed once its case closed) and the change is deliberate: after a
    // replacement exists, the merchant's working device IS the replacement, so
    // the next round of damage belongs to it.
    //
    // The partial unique index assignment_one_live_case (migration
    // 20260816210000) still backs the rule at the database, which is what makes
    // a concurrent double-flag safe rather than racy; the catch below maps its
    // 23505 to the same conflict.

    await onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:flag-damage'), async () => {
    // ONLY THE CHAIN TIP CAN BE FLAGGED (DAMAGE.md, 21 Aug 2026).
    //
    // Damage used to be flaggable on any dispatch whose case had closed, which
    // meant a second round of damage landed on the ORIGINAL rather than on the
    // replacement the merchant is actually holding. That produced two sibling
    // replacements of one parent instead of a chain, and neither knew about the
    // other.
    //
    // A dispatch with ANY replacement child is therefore no longer flaggable,
    // open case or closed. The refusal names the tip so the caller can go
    // straight there rather than guessing which of the chain is current.
    // INSIDE THE onceWithin, unlike every validation above it, and that
    // placement is the whole reason this works. A replay of the same
    // Idempotency-Key never reaches here: onceWithin's inbox row short-circuits
    // the body, so the retry returns its original answer instead of tripping
    // over the child it already created.
    //
    // An exclusion by source_event_id was tried instead and cannot work: the
    // child's key is derived from the PARENT now, so a genuine second attempt
    // computes the same key as the first and would exclude the very row it
    // needs to see. The client key is the only thing that separates a retry
    // from a new request, and the inbox is where the client key lives.
    //
    // A state conflict consuming the idempotency key is correct, unlike the
    // input validations above: the caller's request was well formed and the
    // answer is stable, so replaying it should keep returning that answer.
    const existingReplacement = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM assignment
      WHERE replacement_of = ${parentUuid}::uuid
      ORDER BY created_at DESC
      LIMIT 1
    `
    if (existingReplacement.length > 0) {
      // Walk to the newest descendant, not just the immediate one: after two
      // rounds the caller needs the END of the chain, and replacement_of is a
      // one-level pointer so the walk has to be explicit.
      const tip = await tx.$queryRaw<{ id: string }[]>`
        WITH RECURSIVE chain AS (
          SELECT id, created_at FROM assignment WHERE id = ${parentUuid}::uuid
          UNION ALL
          SELECT a.id, a.created_at FROM assignment a JOIN chain c ON a.replacement_of = c.id
        )
        SELECT id::text AS id FROM chain ORDER BY created_at DESC LIMIT 1
      `
      throw new OpsClientError(
        'conflict',
        `this dispatch has already been replaced; flag the current one instead (${fromUuid('asgn', tip[0]!.id)})`,
      )
    }

      // enterWriteScope is deliberately INSIDE onceWithin (same reasoning as
      // updateDamageCaseStatusOps): the inbox INSERT is not program-gated, and
      // binding the scope here keeps the WITH-CHECK program next to the writes
      // it guards.
      await enterWriteScope(tx, 'tms_write', parent.program_id)

      const childUuid = toUuid(newId('asgn'))
      // updated_at is @updatedAt in the Prisma schema, which is client-API
      // middleware only (it does not run for $queryRaw/$executeRaw) and the
      // column has no DB-level DEFAULT, so it is set explicitly here, same as
      // the other raw assignment INSERTs in this service. bank_remarks stays
      // NULL: no bank wrote anything, and pretending otherwise would put words
      // in the bank's mouth. ON CONFLICT mirrors the old mint as a structural
      // net under the (source_event_id, dispatch_group) unique.
      // The read above cannot see a CONCURRENT transaction's uncommitted
      // child, so the one-live-case rule is ultimately the partial unique
      // index assignment_one_live_case (migration 20260816210000). A racing
      // flag surfaces here as a 23505 on that index, mapped to the SAME
      // conflict the read raises, so the caller sees one 409 either way.
      let won: { id: string }[]
      try {
        won = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO assignment (
          id, merchant_id, program_id, tenant_id,
          merchant_display_name, merchant_legal_name, merchant_mcc,
          bank_reference_code, bank_display_name, ship_to_address,
          qr_value, vpa_value, soundbox, standee_count, sticker_count,
          billable, replacement_of, damage_reason, ops_remarks, flagged_by, case_status,
          demand_state, origin, source_event_id, contact_name, mobile, branch_code, dispatch_group, updated_at
        ) VALUES (
          ${childUuid}::uuid, ${parent.merchant_id}::uuid, ${parent.program_id}::uuid, ${parent.tenant_id}::uuid,
          ${parent.merchant_display_name}, ${parent.merchant_legal_name}, ${parent.merchant_mcc},
          ${parent.bank_reference_code}, ${parent.bank_display_name}, ${parent.ship_to_address},
          ${parent.qr_value}, ${parent.vpa_value}, ${soundbox}, ${standeeCount}, ${stickerCount},
          ${false}, ${parent.id}::uuid, ${args.reasonCode}, ${remarks}, ${args.actorId}, ${'Open'},
          ${'received'}, ${'ADDITIONAL'}, ${sourceEventId}, ${parent.contact_name}, ${parent.mobile}, ${parent.branch_code}, ${parent.dispatch_group}, now()
        )
        ON CONFLICT (source_event_id, dispatch_group) DO NOTHING
        RETURNING id
      `
      } catch (err) {
        // Prisma surfaces the raw Postgres failure as text carrying the
        // SQLSTATE and the violated key, NOT the index name. 23505 on
        // replacement_of can only be assignment_one_live_case here: the
        // (source_event_id, dispatch_group) unique is absorbed by the ON
        // CONFLICT arbiter above and the PK is a fresh uuid.
        if (err instanceof Error && err.message.includes('23505') && err.message.includes('replacement_of')) {
          throw new OpsClientError('conflict', 'this dispatch already has a live damage case')
        }
        throw err
      }
      if (won.length === 0) return // the child already exists (idempotent net)

      const childId = fromUuid('asgn', childUuid)
      // The linkage fact. damageReason carries the master CODE (DP-5) and
      // bankRemarks is honestly empty: no bank reported this damage, and the
      // operator's own words never ride a fact (S7, same posture as
      // ops_remarks on the schema).
      await enqueue(tx, {
        aggregateType: 'assignment',
        aggregateId: childId,
        eventType: TMS_REPLACEMENT_RAISED_TOPIC,
        partitionKey: childId,
        payload: replacementRaisedFactEnvelope({
          payload: {
            asgnId: childId,
            replacedAsgnId: fromUuid('asgn', parent.id),
            damageReason: args.reasonCode,
            bankRemarks: '',
          },
          dedupKey: eventKey(`${sourceEventId}|${parent.dispatch_group}`, 'tms.assignment.replacement_raised'),
          traceId: args.traceId,
        }),
      })
      // Demand fact plus pooled-for-fulfillment (billable=false already
      // stored), then the parent's move to replacement-raised, both exactly as
      // the file mint did them so nothing downstream can tell the entries
      // apart.
      await emitDemandFact(tx, childUuid, `${sourceEventId}|${parent.dispatch_group}`, args.traceId)
      await tx.$executeRaw`UPDATE assignment SET demand_state = 'replacement-raised', updated_at = now() WHERE id = ${parent.id}::uuid`

      // Co-commit the ALLOW 6e (spec 10c CC-1) in the SAME tx as the mint.
      // IDs and enum tokens only (S7/S10.5): the parent and the minted child.
      const record: AuthzAuditRecord = {
        principalId: args.actorId,
        cls: 3,
        actorChannel: 'human-direct',
        operation: 'ops:flag-damage',
        decision: 'ALLOW',
        outcome: 'allowed',
        resourceIds: [args.asgnId, childId],
        traceId: args.traceId,
      }
      await enqueue(tx, buildAuthzAuditEvent(record))
    })

    // One lookup serves both the fresh mint and the client-key replay (the
    // onceWithin body never runs on a replay): the correlation id names the
    // child either way, under the (source_event_id, dispatch_group) unique.
    const child = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM assignment
      WHERE source_event_id = ${sourceEventId} AND dispatch_group = ${parent.dispatch_group}
    `
    if (child.length !== 1) {
      throw new Error(`flagDamageOps: minted child not found for ${sourceEventId}`)
    }
    return { childAsgnId: fromUuid('asgn', child[0]!.id), caseStatus: 'Open' as const }
  })
}
