import { fromUuid, toUuid } from '@andpay/ids'
import type { TmsDb } from './db.js'
import type { Tx } from './internal.js'
import { toDamageReasonDto, type DamageReasonDbRow, type DamageReasonRow } from './damage-reason.js'

// spec 10c ops read (Task 5). The ops queue view over quarantine_row for the
// class-3 human ops portal. `tms_ops_read` is broad (its SELECT policy is
// USING(true), B1): unlike the tenant class-2 read role there is no
// program_ids GUC to bind, so this is a plain `SET LOCAL ROLE` with no
// analog to `enterReadScope`. Reads ONLY the tms schema (C4): no other
// context's schema, no cross-context source import, no HTTP dependency.
/**
 * The per-reason structured evidence on a quarantine record (ruling
 * 2026-08-10). Optional everywhere: only `duplicate_vpa_soundbox` writes it
 * today, and every other reason leaves `detail` null.
 *
 * `duplicateOf` names the record the held soundbox row collides with, so the
 * ops queue can show "VPA -> original" rather than making an operator go and
 * find it. `kind` is typed as a plain string union matching
 * services/tms/src/ingest.ts DuplicateVpaOriginal; the value is written by this
 * context and read back by it, so no cross-context contract is involved.
 */
export interface QuarantineRowDetail {
  duplicateOf?: {
    kind: 'assignment' | 'pending_row' | 'file_row'
    reference: string
    merchantDisplayName: string | null
  }
}

export interface QuarantineRowView {
  id: string
  fileId: string
  rowNo: number
  reasonCode: string
  detail: QuarantineRowDetail | null
  createdAt: Date
  resolvedAt: Date | null
  resolvedByActor: string | null
  /**
   * WHICH of D-8's two actions retired this row: 'cured' (an ingest was
   * re-driven) or 'closed' (archived as a genuine duplicate). Null while the
   * row is still open, and also null on rows resolved before the distinction
   * existed, which are deliberately not backfilled.
   */
  resolution: 'cured' | 'closed' | null
}

// The exact (aliased) snake_case shape of the SELECT below, typed directly
// against $queryRaw so the result needs no cast.
interface QuarantineRowDbRow {
  id: string
  file_id: string
  row_no: number
  reason_code: string
  // jsonb, so the driver hands back the parsed value already; null for every
  // reason that carries no evidence, which is all of them but one today.
  detail: QuarantineRowDetail | null
  created_at: Date
  resolved_at: Date | null
  resolved_by_actor: string | null
  resolution: 'cured' | 'closed' | null
}

function toDto(r: QuarantineRowDbRow): QuarantineRowView {
  return {
    id: r.id,
    fileId: r.file_id,
    rowNo: r.row_no,
    reasonCode: r.reason_code,
    detail: r.detail,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedByActor: r.resolved_by_actor,
    resolution: r.resolution,
  }
}

// Phase 3 Task 1 (BRD FR-08, FR-11): the class-3 admin list view over the
// damage_reason master. Platform-only (no program_id), permissive v1 RLS
// (`damage_reason_v1` USING(true)), so this is a plain `SET LOCAL ROLE` with
// no analog to enterReadScope, exactly like listVendors/readQuarantineQueue
// above. Returns EVERY row (active and inactive): the admin UI needs to see
// and toggle both, unlike the ingest match (damage.ts), which filters to
// active = true itself.
export async function listDamageReasons(db: TmsDb): Promise<DamageReasonRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_ops_read')
    return tx.$queryRaw<DamageReasonDbRow[]>`
      SELECT id, code, label, active, created_at, updated_at FROM damage_reason ORDER BY code
    `
  })
  return rows.map(toDamageReasonDto)
}

// FR08-2 (BRD 5.8): the ops working list of damage cases (replacements). Same
// context (reads only the tms assignment table under the broad tms_ops_read
// role, assignment_ops_read USING(true)); NO fact/topic, NO cross-context read.
// Emits WIRE asgn ids (D-A: reads emit wire ids) for both the replacement and
// the original it replaced, so the case-status transition write can decode them.
// Defaults to open cases (case_status <> 'Closed'); includeClosed shows all.
export interface DamageCaseView {
  asgnId: string
  replacementOf: string
  merchantDisplayName: string
  bankReferenceCode: string
  /** For the Name (CODE) display rule (DEC-14); the read carried only the code. */
  bankDisplayName: string
  branchCode: string | null
  /**
   * SOUNDBOX or COLLATERAL (DAMAGE.md). Absent from this read until 21 Aug 2026,
   * which meant the damage-cases page could not tell a soundbox case from a
   * collateral one at all: the two close on different rules and an operator
   * chasing one has to know which they are looking at.
   */
  dispatchGroup: 'SOUNDBOX' | 'COLLATERAL'
  damageReason: string | null
  /** What the BANK wrote on the damage row. */
  bankRemarks: string | null
  /** What an OPERATOR wrote about the case (T6.4). Different people's words. */
  opsRemarks: string | null
  caseStatus: string | null
  /** Why it was cancelled, on a Cancelled case only. */
  caseCancelRemarks: string | null
  billable: boolean
  demandState: string
  createdAt: Date
  updatedAt: Date
}

interface DamageCaseDbRow {
  id: string
  replacement_of: string
  merchant_display_name: string
  bank_reference_code: string
  bank_display_name: string
  branch_code: string | null
  dispatch_group: 'SOUNDBOX' | 'COLLATERAL'
  damage_reason: string | null
  bank_remarks: string | null
  ops_remarks: string | null
  case_status: string | null
  case_cancel_remarks: string | null
  billable: boolean
  demand_state: string
  created_at: Date
  updated_at: Date
}

function toDamageCaseDto(r: DamageCaseDbRow): DamageCaseView {
  return {
    asgnId: fromUuid('asgn', r.id),
    replacementOf: fromUuid('asgn', r.replacement_of),
    merchantDisplayName: r.merchant_display_name,
    bankReferenceCode: r.bank_reference_code,
    bankDisplayName: r.bank_display_name,
    branchCode: r.branch_code,
    dispatchGroup: r.dispatch_group,
    damageReason: r.damage_reason,
    bankRemarks: r.bank_remarks,
    opsRemarks: r.ops_remarks,
    caseStatus: r.case_status,
    caseCancelRemarks: r.case_cancel_remarks,
    billable: r.billable,
    demandState: r.demand_state,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function readDamageCases(
  db: TmsDb,
  args: { includeClosed: boolean },
): Promise<DamageCaseView[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_ops_read')
    return args.includeClosed
      ? await tx.$queryRaw<DamageCaseDbRow[]>`
          SELECT id, replacement_of, merchant_display_name, bank_reference_code, bank_display_name, branch_code,
                 dispatch_group, damage_reason, bank_remarks, ops_remarks, case_status,
                 case_cancel_remarks, billable, demand_state, created_at, updated_at
          FROM assignment
          WHERE replacement_of IS NOT NULL
          ORDER BY created_at
        `
      : await tx.$queryRaw<DamageCaseDbRow[]>`
          SELECT id, replacement_of, merchant_display_name, bank_reference_code, bank_display_name, branch_code,
                 dispatch_group, damage_reason, bank_remarks, ops_remarks, case_status,
                 case_cancel_remarks, billable, demand_state, created_at, updated_at
          FROM assignment
          WHERE replacement_of IS NOT NULL AND case_status IS DISTINCT FROM 'Closed'
          ORDER BY created_at
        `
  })
  return rows.map(toDamageCaseDto)
}

// D-26 (DP-6): the by-VPA dispatch search, the customer-support entry point
// for "this merchant called about a damaged device". Returns the TMS side of
// every dispatch leg on the VPA (identity, dispatch group, product columns,
// billable, the parent link, the case overlay, demand and activation state);
// the courier branch status is analytics-held, and the portal enriches rows
// via the existing per-dispatch detail read instead of a new cross-context
// merge at the edge. Same posture as every read above: tms_ops_read, the tms
// schema only (C4), wire ids out (D-A), parameters always bound and never
// concatenated. Timestamps go out as ISO strings per the pinned contract.
export interface VpaDispatchRow {
  asgnId: string
  dispatchGroup: 'SOUNDBOX' | 'COLLATERAL'
  bankReferenceCode: string
  bankDisplayName: string
  merchantDisplayName: string
  soundbox: boolean
  standeeCount: number
  stickerCount: number
  billable: boolean
  replacementOfAsgnId: string | null
  caseStatus: string | null
  demandState: string
  /** Derived from activatedAt (ACTIVATION.md): 'ACTIVATED' or null. */
  activationStatus: string | null
  activatedAt: string | null
  /** Who marked it activated, null when no operator was behind it. */
  activatedBy: string | null
  createdAt: string
}

interface VpaDispatchDbRow {
  id: string
  dispatch_group: 'SOUNDBOX' | 'COLLATERAL'
  bank_reference_code: string
  bank_display_name: string
  merchant_display_name: string
  soundbox: boolean
  standee_count: number
  sticker_count: number
  billable: boolean
  replacement_of: string | null
  case_status: string | null
  demand_state: string
  activated_at: Date | null
  activated_by: string | null
  created_at: Date
}

// The match is LOWER(TRIM(...)) on both sides: the operator types what the
// merchant reads out, and neither casing nor a stray space should hide a
// record. Newest first, because the leg the merchant is calling about is
// almost always the most recent one.
export async function searchDispatchesByVpa(db: TmsDb, vpa: string): Promise<VpaDispatchRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_ops_read')
    return tx.$queryRaw<VpaDispatchDbRow[]>`
      SELECT id, dispatch_group, bank_reference_code, bank_display_name, merchant_display_name,
             soundbox, standee_count, sticker_count, billable, replacement_of, case_status,
             demand_state, activated_at, activated_by::text AS activated_by, created_at
      FROM assignment
      WHERE LOWER(TRIM(vpa_value)) = LOWER(TRIM(${vpa}))
      ORDER BY created_at DESC
    `
  })
  return rows.map((r) => ({
    asgnId: fromUuid('asgn', r.id),
    dispatchGroup: r.dispatch_group,
    bankReferenceCode: r.bank_reference_code,
    bankDisplayName: r.bank_display_name,
    merchantDisplayName: r.merchant_display_name,
    soundbox: r.soundbox,
    standeeCount: r.standee_count,
    stickerCount: r.sticker_count,
    billable: r.billable,
    replacementOfAsgnId: r.replacement_of === null ? null : fromUuid('asgn', r.replacement_of),
    caseStatus: r.case_status,
    demandState: r.demand_state,
    // ACTIVATION.md (21 Aug 2026): derived, not stored. The old
    // activation_status column is gone; a set activated_at IS the activation.
    activationStatus: r.activated_at === null ? null : 'ACTIVATED',
    activatedAt: r.activated_at === null ? null : r.activated_at.toISOString(),
    activatedBy: r.activated_by,
    createdAt: r.created_at.toISOString(),
  }))
}

/**
 * THE REPLACEMENT CHAIN through any member of it (DAMAGE.md, 21 Aug 2026).
 *
 * replacement_of is a ONE-LEVEL pointer, and nothing walked it. That was fine
 * while a chain was at most two long, and stopped being fine the moment repeat
 * damage became a real flow: an operator holding the third generation could see
 * its parent and had no way to reach the original, and an operator on the
 * original could not tell that two replacements had already been through.
 *
 * Walks UP to the root first and then DOWN, so any member returns the same whole
 * chain: "show me this dispatch's history" is the same question whichever
 * generation you ask it from.
 *
 * ORDERED OLDEST FIRST, so the caller renders a progression without sorting.
 *
 * NOT AN AGGREGATE, which matters here: this module is row-level only by
 * construction (architecture.test.ts check 7). WITH RECURSIVE is a row-producing
 * query, not a count or a group by, so it is inside the rule rather than an
 * exception to it.
 */
export interface ChainMemberRow {
  asgnId: string
  /** The one it replaces, null on the root. */
  replacementOfAsgnId: string | null
  dispatchGroup: string
  caseStatus: string | null
  demandState: string
  damageReason: string | null
  billable: boolean
  activatedAt: string | null
  deliveredAt: string | null
  createdAt: string
  /** 0 for the original, 1 for its replacement, and so on. */
  generation: number
}

export async function readReplacementChainOps(db: TmsDb, asgnId: string): Promise<ChainMemberRow[]> {
  const asgnUuid = toUuid(asgnId)
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_ops_read')
    return tx.$queryRaw<
      {
        id: string
        replacement_of: string | null
        dispatch_group: string
        case_status: string | null
        demand_state: string
        damage_reason: string | null
        billable: boolean
        activated_at: Date | null
        delivered_at: Date | null
        created_at: Date
        generation: number
      }[]
    >`
      WITH RECURSIVE up AS (
        -- Climb to the root: the ancestor with no replacement_of.
        SELECT id, replacement_of FROM assignment WHERE id = ${asgnUuid}::uuid
        UNION ALL
        SELECT a.id, a.replacement_of FROM assignment a JOIN up u ON a.id = u.replacement_of
      ),
      root AS (
        SELECT id FROM up WHERE replacement_of IS NULL LIMIT 1
      ),
      down AS (
        -- Then descend from it, numbering the generations as we go.
        SELECT a.id, a.replacement_of, 0 AS generation
        FROM assignment a JOIN root r ON a.id = r.id
        UNION ALL
        SELECT c.id, c.replacement_of, d.generation + 1
        FROM assignment c JOIN down d ON c.replacement_of = d.id
      )
      SELECT a.id::text AS id, a.replacement_of::text AS replacement_of, a.dispatch_group,
             a.case_status, a.demand_state, a.damage_reason, a.billable,
             a.activated_at, a.delivered_at, a.created_at, d.generation
      FROM down d JOIN assignment a ON a.id = d.id
      ORDER BY d.generation ASC, a.created_at ASC
    `
  })
  return rows.map((r) => ({
    asgnId: fromUuid('asgn', r.id),
    replacementOfAsgnId: r.replacement_of === null ? null : fromUuid('asgn', r.replacement_of),
    dispatchGroup: r.dispatch_group,
    caseStatus: r.case_status,
    demandState: r.demand_state,
    damageReason: r.damage_reason,
    billable: r.billable,
    activatedAt: r.activated_at === null ? null : r.activated_at.toISOString(),
    deliveredAt: r.delivered_at === null ? null : r.delivered_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    generation: Number(r.generation),
  }))
}

// THE MERCHANT REQUEST, which the platform has always had and never shown
// (DAMAGE.md, 21 Aug 2026).
//
// source_event_id IS the request identity: both legs of one bank-file row carry
// it, the pool groups by it, and the minimum-lot batching gate counts DISTINCT
// values of it. There is no `request` table and there does not need to be; the
// key is the relationship. What was missing was any screen that asked the
// question the key answers, so an operator holding a merchant's complaint had
// to work backwards from a dispatch and guess which siblings belonged with it.
//
// FLAT ROWS, ONE PER LEG, grouped by the caller. Not a GROUP BY: the curated
// read modules are row-level only by construction (architecture.test.ts check 7),
// and the pool page already groups by this exact key client-side, so the shape
// is the established one rather than a new pattern.
//
// Newest first, capped, because an operator arrives with a recent complaint and
// an unbounded scan of every assignment ever minted is not a page.
export interface RequestLegRow {
  sourceEventId: string
  asgnId: string
  dispatchGroup: string
  merchantDisplayName: string
  bankReferenceCode: string
  bankDisplayName: string
  branchCode: string | null
  vpaValue: string
  soundbox: boolean
  standeeCount: number
  stickerCount: number
  billable: boolean
  demandState: string
  caseStatus: string | null
  /** The dispatch this leg replaces, when it is a replacement. */
  replacementOfAsgnId: string | null
  activatedAt: string | null
  createdAt: string
}

export async function listRequestLegsOps(db: TmsDb, limit = 500): Promise<RequestLegRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_ops_read')
    return tx.$queryRaw<
      {
        source_event_id: string
        id: string
        dispatch_group: string
        merchant_display_name: string
        bank_reference_code: string
        bank_display_name: string
        branch_code: string | null
        vpa_value: string
        soundbox: boolean
        standee_count: number
        sticker_count: number
        billable: boolean
        demand_state: string
        case_status: string | null
        replacement_of: string | null
        activated_at: Date | null
        created_at: Date
      }[]
    >`
      SELECT source_event_id, id, dispatch_group, merchant_display_name,
             bank_reference_code, bank_display_name, branch_code, vpa_value,
             soundbox, standee_count, sticker_count, billable, demand_state,
             case_status, replacement_of, activated_at, created_at
      FROM assignment
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
  })
  return rows.map((r) => ({
    sourceEventId: r.source_event_id,
    asgnId: fromUuid('asgn', r.id),
    dispatchGroup: r.dispatch_group,
    merchantDisplayName: r.merchant_display_name,
    bankReferenceCode: r.bank_reference_code,
    bankDisplayName: r.bank_display_name,
    branchCode: r.branch_code,
    vpaValue: r.vpa_value,
    soundbox: r.soundbox,
    standeeCount: r.standee_count,
    stickerCount: r.sticker_count,
    billable: r.billable,
    demandState: r.demand_state,
    caseStatus: r.case_status,
    replacementOfAsgnId: r.replacement_of === null ? null : fromUuid('asgn', r.replacement_of),
    activatedAt: r.activated_at === null ? null : r.activated_at.toISOString(),
    createdAt: r.created_at.toISOString(),
  }))
}

// D-31 (DP-7): the damage-case tile numbers, per status, over every
// replacement (replacement_of IS NOT NULL). This reads tms and not analytics,
// because case_status is deliberately never projected into analytics (the
// frozen damagedReplacementOpen tile stays frozen).
/**
 * One damage case's status history, oldest first (22 Aug 2026, DAMAGE
 * end-to-end). The trail table existed and was written for a day before
 * anything could READ it, which meant the case lifecycle the damage page was
 * asked to show had its data recorded and unreachable.
 *
 * Keyed by the replacement's asgn id, same as every other case surface. Same
 * ordering rule as fulfillment's trails: occurred_at then created_at, so two
 * transitions in the same reported instant read back in the order the platform
 * learned them.
 */
export interface CaseTrailRow {
  status: string
  occurredAt: Date
  statusSource: string
  actorId: string | null
  /** Operator login handle snapshot (LeanClaim.hdl), display only. */
  actorDisplay: string | null
  /** Operator words, present on Cancelled rows (the mandatory cancel reason). */
  remarks: string | null
  recordedAt: Date
}

export async function readCaseTrailOps(db: TmsDb, asgnId: string): Promise<CaseTrailRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_ops_read')
    return tx.$queryRaw<
      {
        status: string
        occurred_at: Date
        status_source: string
        actor_id: string | null
        actor_display: string | null
        remarks: string | null
        created_at: Date
      }[]
    >`
      SELECT status, occurred_at, status_source, actor_id::text AS actor_id, actor_display, remarks, created_at
      FROM damage_case_status_event
      WHERE asgn_id = ${toUuid(asgnId)}::uuid
      ORDER BY occurred_at ASC, created_at ASC
    `
  })
  return rows.map((r) => ({
    status: r.status,
    occurredAt: r.occurred_at,
    statusSource: r.status_source,
    actorId: r.actor_id,
    actorDisplay: r.actor_display,
    remarks: r.remarks,
    recordedAt: r.created_at,
  }))
}

export interface DamageCaseSummary {
  open: number
  inProgress: number
  closed: number
}

// The SELECT is row-level (one case_status token per replacement) and the
// tally is folded in code, deliberately: this module carries no SQL aggregate
// calls, a DO-NOT enforced by a static net in test/architecture.test.ts that
// also reads comments, which is why this note cannot spell the banned
// function names. A replacement population of tens of rows a day makes the
// fold free. A row whose status is outside the vocabulary (null included)
// lands in no bucket rather than being guessed into one.
export async function countDamageCasesByStatus(db: TmsDb): Promise<DamageCaseSummary> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_ops_read')
    return tx.$queryRaw<{ case_status: string | null }[]>`
      SELECT case_status FROM assignment WHERE replacement_of IS NOT NULL
    `
  })
  const summary: DamageCaseSummary = { open: 0, inProgress: 0, closed: 0 }
  for (const r of rows) {
    if (r.case_status === 'Open') summary.open += 1
    else if (r.case_status === 'In-Progress') summary.inProgress += 1
    else if (r.case_status === 'Closed') summary.closed += 1
  }
  return summary
}

// Redesign step 7 (ruling 1b): the class-3 ops Merchants list. "Find the
// merchant" is the most common ops entry point, and until now the portal had no
// merchant read at all, which is why an entity-first nav shipped without its
// primary entity.
//
// Reads ONLY the tms schema (C4). merchant_projection is TMS's own projection of
// the merchant fact (projections.ts), so this crosses no context boundary and
// needs no read of identity.merchant, which holds the same data on the other
// side of that boundary.
//
// Emits the WIRE id (D-A: reads emit wire ids), never the raw uuid.
//
// PII-free by construction (D104 default-exclude), and not by filtering: the
// table holds display_name, legal_name, mcc and status only. The recipient
// address, contact name and mobile that the pool list guards against live on
// the assignment and the pool entry, never here.
//
// Rejected shape: deriving this from pending_pool_entry (option 1c). It shows
// only in-flight merchants, so a search would silently omit settled ones and
// the operator could not tell the difference between "no such merchant" and
// "that merchant has nothing in flight".
export interface MerchantRow {
  mrchId: string
  displayName: string
  legalName: string
  mcc: string
  status: string
  updatedAt: Date
  /**
   * D-2: this merchant has more than one soundbox request, so at least one was
   * an ADDITIONAL request rather than a first order (BRD 5.1b). Derived on read
   * from `assignment`, never stored, so it cannot drift from the requests it
   * describes.
   */
  hasAdditionalRequests: boolean
}

interface MerchantDbRow {
  id: string
  display_name: string
  legal_name: string
  mcc: string
  status: string
  updated_at: Date
  has_additional_requests: boolean
}

function toMerchantDto(r: MerchantDbRow): MerchantRow {
  return {
    mrchId: fromUuid('mrch', r.id),
    displayName: r.display_name,
    legalName: r.legal_name,
    mcc: r.mcc,
    status: r.status,
    updatedAt: r.updated_at,
    hasAdditionalRequests: r.has_additional_requests,
  }
}

// Ordered by display_name because the operator scans this list by the name they
// call the merchant, not by when it arrived. Every row is returned, active and
// suspended alike: a merchant search that hides suspended merchants would send
// the operator looking for a record that does exist.
export async function listMerchants(db: TmsDb): Promise<MerchantRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_ops_read')
    // D-2, the additional-soundbox tag, DERIVED HERE rather than carried.
    //
    // BRD 5.1b: "If VPA is already present in system, tag request as additional
    // soundbox request for an already existing merchant." Identity computes
    // exactly that signal (`mintedMerchant` in project.ts) and then drops it: it
    // rides no fact, so no screen could tell a returning merchant from a new
    // one. Bhupender ruled it should be DERIVED AT READ TIME rather than added
    // to the enrollment fact, which would be a fact-schema change and therefore
    // a corpus decision.
    //
    // It costs nothing to keep true: there is no column, no migration and no
    // projection to backfill or drift, and deleting a request makes the tag go
    // away by itself. TMS owns both tables, so this crosses no context (C4).
    //
    // A SELF-JOIN AND AN EXISTS, deliberately not a counting aggregate. The
    // no-aggregate DO-NOT (test/architecture.test.ts) keeps this module
    // row-level: the ops portal is a queue and detail surface, never a
    // dashboard. "Two distinct requests exist for this merchant" is a row-level
    // EXISTS question, so this honours the rule's intent and not merely its
    // regex.
    //
    // That guard also READS COMMENTS, so this note cannot spell the banned
    // function name even while explaining why it is avoided. It caught exactly
    // that on the first run here.
    return tx.$queryRaw<MerchantDbRow[]>`
      SELECT m.id, m.display_name, m.legal_name, m.mcc, m.status, m.updated_at,
             EXISTS (
               SELECT 1 FROM assignment a1
               JOIN assignment a2 ON a2.merchant_id = a1.merchant_id AND a2.id <> a1.id
               WHERE a1.merchant_id = m.id
             ) AS has_additional_requests
      FROM merchant_projection m
      ORDER BY m.display_name, m.id
    `
  })
  return rows.map(toMerchantDto)
}

export async function readQuarantineQueue(
  db: TmsDb,
  args: { includeResolved: boolean },
): Promise<QuarantineRowView[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_ops_read')
    return args.includeResolved
      ? await tx.$queryRaw<QuarantineRowDbRow[]>`
          SELECT id, file_id, row_no, reason_code, detail, created_at, resolved_at, resolved_by_actor,
                 resolution
          FROM quarantine_row
          ORDER BY created_at
        `
      : await tx.$queryRaw<QuarantineRowDbRow[]>`
          SELECT id, file_id, row_no, reason_code, detail, created_at, resolved_at, resolved_by_actor,
                 resolution
          FROM quarantine_row
          WHERE resolved_at IS NULL
          ORDER BY created_at
        `
  })
  return rows.map(toDto)
}

// readActivationTrailOps / ActivationTrailOpsRow DELETED (ACTIVATION.md,
// 21 Aug 2026): activation has no trail any more, it is a parallel toggle
// (Assignment.activatedAt/activatedBy). The per-dispatch detail page reads
// those two columns directly instead of a trail.
