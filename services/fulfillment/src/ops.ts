import { fromUuid, toUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { buildAuthzAuditEvent, type AuthzAuditRecord } from '@andpay/audit'
import { instanceKey } from '@andpay/keys'
import type { Acr } from '@andpay/authz'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteScope, enterWriteRole } from './write-context.js'
import { advanceShipmentStatus, type AdvanceOutcome } from './courier-status.js'
import { SHIPMENT_TOPIC, shipmentFactEnvelope } from './events.js'
import { holdEntryWithinTx, triggerBatchWithinTx } from './batching.js'
import { DEFAULT_POOL_CFG } from './config/pool-config.js'
import { ingestIntakeSheetWithinTx, isSheetStructurallyValid, type IntakeSheet, type IntakeResult } from './intake.js'
import { createVendorWithinTx, updateVendorWithinTx } from './vendor.js'
import type { AssetStore } from './storage/asset-store.js'
import { PDFDocument } from 'pdf-lib'

// spec 10c ops writes on shpt_ (Task 6). Both handlers are class-3 human ops
// actions (D-3); the ops HTTP edge (T9) calls these in-process and enforces
// step-up there, NOT here (the domain op assumes an already-authorized,
// stepped-up caller). Each resolves the target shpt_'s program SERVER-SIDE
// (never a request body, M7/S16/D99), enters the fulfillment_write scope
// FIRST, then runs its effect under a client-key instance dedup (rule 1,
// 06.A) via the shared E6 inbox, so a replay of the same clientKey does not
// double-apply.
//
// C3-bypass containment: `overrideTerminal` is the ONLY function in this repo
// that writes shpt.status without the C3 terminal guard. `correctStatus`
// NEVER bypasses C3: it goes only through `advanceShipmentStatus`'s single
// rowcount-gated UPDATE (courier-status.ts), which excludes DELIVERED and
// RETURNED. A correction that tries to exit a terminal is therefore
// naturally non-advancing, and override_reason stays NULL (advanceShipmentStatus
// never sets it).

// Fix wave 1 (Task 9 review, Important 1): a discriminated client-error so the
// ops HTTP edge (T9) can map an expected client condition (an unknown target,
// a bad request shape) to a 4xx via `instanceof` / duck-typing on `kind`,
// instead of Nest's default 500 for a plain `Error`. `kind` is intentionally
// narrow (only the two shapes this domain throws): 'not-found' for a missing
// target row, 'invalid' for a caller-supplied value that fails validation.
// A disclosure-safe reason a client error may carry ACROSS the HTTP boundary.
//
// Read this before adding a field. `OpsClientError.message` is a domain message
// and may embed caller-supplied input (a filename, a cell value), so
// OpsErrorFilter deliberately never returns it (S4/5c). Everything on this type
// must instead be SERVER-CONTROLLED: `code` is a closed enum owned by the
// service, `column` is a canonical column name from the adapter's own HEADERS
// constant. Never put an uploaded filename, a cell value, a row's contents, or
// any other caller-influenced string here.
export interface OpsClientErrorReason {
  code: string
  column?: string
}

// Fix wave 2 (Finding 2/3): the closed set of machine-readable codes the
// bank-template upload door (setBankTemplateMaster) can throw, exactly the
// DeviceInventoryStructuralErrorCode precedent (device-inventory-adapter.ts)
// for turning a domain reject into a code the ops-edge OpsErrorFilter can ride
// across the HTTP boundary via `reasons` (S4/5c: the code is server-owned and
// caller-uninfluenced, never the domain message itself). Before this, both
// checks below threw with only a human message riding `Error.message`, which
// OpsErrorFilter deliberately NEVER returns (it can embed caller input on
// other throw sites), so the two rejects were indistinguishable 400s on the
// wire: a portal could not tell "not a PDF" from "trim mismatch" from
// "rotated" without parsing prose. `template_rotated` (Finding 3) joins the
// same closed set rather than inventing a parallel one, since all three are
// the same upload door rejecting the same candidate for a different reason.
export type TemplateMasterErrorCode = 'template_not_pdf' | 'template_trim_mismatch' | 'template_rotated'

export class OpsClientError extends Error {
  constructor(
    public readonly kind: 'not-found' | 'invalid',
    message: string,
    // Optional and additive: every existing throw site is unchanged and keeps
    // returning a bare fixed body.
    public readonly reasons?: OpsClientErrorReason[],
  ) {
    super(message)
  }
}

// Phase 3 Task 2 (BRD FR-11): a raw-SQL unique-constraint violation (mirrors
// tms/src/ops.ts's identical helper, `isRawUniqueViolation`, verified there
// against the same exact INSERT shape). `$executeRaw`/`$queryRaw` surface a
// constraint violation as Prisma error code 'P2010' ("raw query failed") with
// the ORIGINAL Postgres SQLSTATE inside `meta.code`; '23505' is Postgres's
// unique_violation SQLSTATE. courier_code is @unique on vndr, so a duplicate
// on create or edit trips this, and is mapped to a clean 4xx (OpsClientError),
// never a raw 500.
function isRawUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false
  if ((err as { code?: unknown }).code !== 'P2010') return false
  const meta = (err as { meta?: unknown }).meta
  return typeof meta === 'object' && meta !== null && 'code' in meta && (meta as { code?: unknown }).code === '23505'
}

// The co-committed ALLOW 6e record (S15/T2 ruling, spec 10c CC-1b). Every ops
// MUTATION enqueues its ALLOW authz.audit INSIDE the same domain transaction
// as the effect, via `enqueue(tx, buildAuthzAuditEvent(opsAllow(...)))` on the
// SAME `tx`, in the SAME committing branch (inside the op's client-key
// `onceWithin` callback). The 6e is an authorization-decision audit (S15): it
// is emitted whenever the co-committed callback RUNS, i.e. once per AUTHORIZED
// ATTEMPT, regardless of the effect's row-count or outcome (a trail-only
// correction or an empty-pool batch trigger is still an authorized, audited
// attempt). The domain row owns the state change (T2); the 6e owns the authz
// decision, not the row effect. A rolled-back callback leaves NO 6e (co-commit
// still holds), and a same-client-key REPLAY never re-enters the callback at
// all (the E6 inbox dedup suppresses it), so a replay emits NO second 6e:
// exactly one ALLOW per authorized attempt, not per row mutated. IDs and enums
// ONLY (S7/S10.5): the free-text override reason NEVER rides this record
// (DD1); only `overrideTerminal` carries reasonCode 'terminal-override' plus
// the step-up assurance (acr, authTime) that authorized the C3 bypass, nothing
// more.
function opsAllow(args: {
  operation: string
  principalId: string
  resourceIds: string[]
  traceId: string
  reasonCode?: string
  acr?: Acr
  authTime?: number
}): AuthzAuditRecord {
  return {
    principalId: args.principalId,
    cls: 3,
    actorChannel: 'human-direct',
    operation: args.operation,
    decision: 'ALLOW',
    outcome: 'allowed',
    ...(args.reasonCode !== undefined ? { reasonCode: args.reasonCode } : {}),
    ...(args.acr !== undefined ? { acr: args.acr } : {}),
    ...(args.authTime !== undefined ? { authTime: args.authTime } : {}),
    resourceIds: args.resourceIds,
    traceId: args.traceId,
  }
}

interface ShptProgramAwb { programId: string; awb: string; courierPartner: string | null }

async function resolveProgramAndAwb(tx: Tx, shptId: string): Promise<ShptProgramAwb> {
  const found = await tx.$queryRaw<{ program_id: string; awb: string; courier_partner: string | null }[]>`
    SELECT program_id::text AS program_id, awb, courier_partner::text AS courier_partner
    FROM shpt WHERE id = ${shptId}::uuid
  `
  if (found.length === 0) throw new OpsClientError('not-found', 'shpt not found')
  return { programId: found[0]!.program_id, awb: found[0]!.awb, courierPartner: found[0]!.courier_partner }
}

/**
 * A normal manual status correction. Routed ONLY through `advanceShipmentStatus`
 * as an OPS_MANUAL source, so it is subject to the SAME C3 successor-table
 * validation as any courier event: a terminal-exit attempt yields the
 * non-advancing outcome ('trail_only'), never a status change, and
 * override_reason is never written on this path.
 *
 * `deduped: true` means this call was a client-key replay of an EARLIER call
 * (the E6 inbox already ran the effect); `outcome` is only meaningful when
 * `deduped` is false, and is `null` on a replay (unambiguous, unlike
 * overloading advanceShipmentStatus's own 'deduped' outcome, which means the
 * inner per-transition key was already claimed, a different, narrower thing).
 */
export async function correctStatus(
  db: FulfillmentDb,
  args: { shptId: string; status: string; courierTimestamp: Date; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean; outcome: AdvanceOutcome | null }> {
  const shptUuid = toUuid(args.shptId)
  let outcome: AdvanceOutcome | null = null
  const ran = await db.$transaction(async (tx: Tx) => {
    const { programId, awb } = await resolveProgramAndAwb(tx, shptUuid)
    await enterWriteScope(tx, 'fulfillment_write', programId)
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:status-correction'), async () => {
      outcome = await advanceShipmentStatus(tx, {
        awb,
        status: args.status,
        courierTimestamp: args.courierTimestamp,
        source: 'OPS_MANUAL',
        sourceRef: args.actorId,
        traceId: args.traceId,
      })
      // Co-commit the ALLOW 6e (spec 10c CC-1b / S15-T2 ruling): unconditional,
      // regardless of advanceShipmentStatus's outcome. The 6e audits the
      // AUTHORIZED ATTEMPT (this callback running), not the row effect: a
      // trail-only correction (a terminal-exit attempt, a stale or regressive
      // report -> 'trail_only', or even an inner per-transition 'deduped') is
      // still an authorized, audited action, even though shpt.status did not
      // change. A same-client-key REPLAY never reaches this callback at all
      // (the OUTER onceWithin above dedups it via the E6 inbox), so it emits
      // no second 6e.
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:status-correction',
            principalId: args.actorId,
            resourceIds: [args.shptId],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })
  return { deduped: !ran, outcome: ran ? outcome : null }
}

/**
 * The privileged terminal override: the ONLY sanctioned C3 bypass (it can
 * reopen a locked terminal state, DELIVERED or RETURNED). A mandatory,
 * non-empty overrideReason is enforced here as defense-in-depth (the edge,
 * T9, enforces it too). The UPDATE deliberately omits the terminal guard;
 * the appended shpt_status_event carries override_reason NOT NULL, so the
 * bypass is always domain-audited.
 *
 * DD1 (critical): the free-text overrideReason NEVER rides the emitted fact
 * or any log line. It lives ONLY on the shpt_status_event.override_reason
 * domain column. The fact reuses the SAME envelope builder / SHIPMENT_TOPIC
 * as the courier path, IDs-only. The human-readable 6e audit-trail entry is
 * emitted later, at the edge (T9), not here.
 *
 * Returns `{ overridden: true }` unconditionally on success: the override is
 * in effect whether THIS call applied it or a prior replay of the same
 * clientKey already did.
 */
export async function overrideTerminal(
  db: FulfillmentDb,
  args: {
    shptId: string
    status: string
    courierTimestamp: Date
    overrideReason: string
    clientKey: string
    actorId: string
    traceId: string
    // The step-up assurance (acr, auth_time) the edge read off the verified
    // claim that authorized this C3 bypass. IDs-and-enums only: these ride the
    // co-committed ALLOW 6e; the free-text overrideReason NEVER does (DD1).
    acr?: Acr
    authTime?: number
  },
): Promise<{ deduped: boolean; overridden: boolean }> {
  if (!args.overrideReason.trim()) throw new OpsClientError('invalid', 'override_reason required')

  const shptUuid = toUuid(args.shptId)

  const ran = await db.$transaction(async (tx: Tx) => {
    const { programId, awb, courierPartner } = await resolveProgramAndAwb(tx, shptUuid)
    await enterWriteScope(tx, 'fulfillment_write', programId)
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:terminal-override'), async () => {
      // The deliberate C3 bypass: no `status NOT IN ('DELIVERED', 'RETURNED')`
      // guard, unlike advanceShipmentStatus's gated UPDATE. This is the ONLY
      // place in the codebase that writes shpt.status this way.
      await tx.$executeRaw`
        UPDATE shpt
        SET status = ${args.status}, status_at = ${args.courierTimestamp},
            status_source = 'OPS_MANUAL', updated_at = now()
        WHERE id = ${shptUuid}::uuid
      `
      await tx.$executeRaw`
        INSERT INTO shpt_status_event
          (shpt_id, program_id, status, courier_timestamp, status_source, source_ref, trace_id, override_reason)
        VALUES
          (${shptUuid}::uuid, ${programId}::uuid, ${args.status}, ${args.courierTimestamp},
           'OPS_MANUAL', ${args.actorId}, ${args.traceId}, ${args.overrideReason})
      `

      // args.shptId is already the caller's wire form (the input contract is
      // now wire, decoded above into shptUuid for the raw SQL); no re-encode
      // needed here.
      const shptWire = args.shptId
      const tsIso = args.courierTimestamp.toISOString()
      await enqueue(tx, {
        aggregateType: 'shpt',
        aggregateId: shptWire,
        eventType: SHIPMENT_TOPIC,
        partitionKey: shptWire,
        payload: shipmentFactEnvelope({
          payload: {
            shptId: shptWire,
            awb,
            ...(courierPartner ? { courierPartner: fromUuid('vndr', courierPartner) } : {}),
            status: args.status,
            courierTimestamp: tsIso,
            statusSource: 'OPS_MANUAL',
          },
          dedupKey: `${shptWire}|${args.status}|${tsIso}`,
          traceId: args.traceId,
        }),
      })

      // Co-commit the privileged-action ALLOW 6e (spec 10c CC-1): the override
      // always mutates when this callback runs, so the ALLOW is unconditional
      // here, committing in the SAME tx as the raw C3-bypass UPDATE and the
      // status-event row. It carries the enum reasonCode plus the step-up
      // assurance that authorized the bypass; the free-text overrideReason
      // stays ONLY on shpt_status_event.override_reason (DD1).
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:terminal-override',
            principalId: args.actorId,
            resourceIds: [args.shptId],
            traceId: args.traceId,
            reasonCode: 'terminal-override',
            ...(args.acr !== undefined ? { acr: args.acr } : {}),
            ...(args.authTime !== undefined ? { authTime: args.authTime } : {}),
          }),
        ),
      )
    })
  })
  return { deduped: !ran, overridden: true }
}

/**
 * Resolve a `courier_status_exception` (spec 10c Task 8, check 9 sibling):
 * the class-3 ops operator supplies the CORRECT courier/AWB status, which
 * RE-DRIVES the very same C3-guarded `advanceShipmentStatus` the courier
 * channel itself uses (OPS_MANUAL source), then stamps the exception row's
 * resolved_at/resolved_by_actor. `courier_status_exception` is append-only
 * (Fork F/A2): this is the ONLY write this function makes against it, and
 * only when resolved_at was still NULL (a stale/replayed resolve is a no-op
 * on the stamp; the client-key dedup below already prevents a second
 * advance).
 *
 * The shpt's program is resolved SERVER-SIDE by shptId (never a request
 * body, M7/S16/D99), reusing the SAME `resolveProgramAndAwb` helper T6
 * already uses elsewhere in this file, which also yields the awb the
 * StatusUpdate needs. A shptId that resolves to nothing THROWS (same
 * throw-on-not-found policy `resolveProgramAndAwb`'s other callers apply;
 * the ops HTTP edge, T9, maps this to a 4xx).
 */
export async function resolveStatusException(
  db: FulfillmentDb,
  args: {
    exceptionId: string
    shptId: string
    status: string
    courierTimestamp: Date
    clientKey: string
    actorId: string
    traceId: string
  },
): Promise<{ deduped: boolean; outcome: AdvanceOutcome | null }> {
  const shptUuid = toUuid(args.shptId)
  let outcome: AdvanceOutcome | null = null

  const ran = await db.$transaction(async (tx: Tx) => {
    const { programId, awb } = await resolveProgramAndAwb(tx, shptUuid)
    await enterWriteScope(tx, 'fulfillment_write', programId)

    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:resolve-status-exception'), async () => {
      outcome = await advanceShipmentStatus(tx, {
        awb,
        status: args.status,
        courierTimestamp: args.courierTimestamp,
        source: 'OPS_MANUAL',
        sourceRef: args.actorId,
        traceId: args.traceId,
      })

      await tx.$executeRaw`
        UPDATE courier_status_exception
        SET resolved_at = now(), resolved_by_actor = ${args.actorId}::uuid
        WHERE id = ${args.exceptionId}::uuid AND resolved_at IS NULL
      `

      // Co-commit the ALLOW 6e (spec 10c CC-1): the resolve always stamps the
      // exception when this callback runs (whether or not the underlying
      // status advanced), so the ALLOW is unconditional here, committing in
      // the SAME tx as the re-drive and the resolved-at stamp.
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:resolve-status-exception',
            principalId: args.actorId,
            resourceIds: [args.exceptionId],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })

  return { deduped: !ran, outcome: ran ? outcome : null }
}

/**
 * Resolve an `intake_exception` (spec 10c Task 8, check 9 sibling): the
 * class-3 ops operator is authorized at the HTTP edge (T9,
 * `authorizeHuman 'ops:resolve-intake-exception'`), NOT via intake's own
 * STEP A vendor-authorize (`ingestIntakeSheet`'s class-6 gate would reject a
 * class-3 claim outright). So this function never calls the public
 * `ingestIntakeSheet`; instead it runs STEP B itself, the SAME whole-sheet
 * schema validation `ingestIntakeSheet` uses (`isSheetStructurallyValid`,
 * exported from intake.ts for exactly this reuse), and THROWS on a
 * structurally invalid corrected sheet BEFORE opening any transaction: no
 * write of any kind happens on a rejected sheet, not even the resolved_at
 * stamp.
 *
 * `intake_exception` and the `unit` table's intake writes are PLATFORM-ONLY
 * (permissive FORCE RLS, `USING (true)`/`WITH CHECK (true)`, no program
 * gate; verified against the migrations, unit_v1/intake_exception_v1), so
 * this enters `fulfillment_write` bare, with no program to set (mirrors
 * `suspendVendor`'s bare-role pattern elsewhere in this file).
 *
 * `intake_exception` is append-only (Fork F/A2): the ONLY write this makes
 * against it is stamping resolved_at/resolved_by_actor, and only when
 * resolved_at was still NULL. The re-drive itself goes through
 * `ingestIntakeSheetWithinTx` (STEP C, Task 4), which carries its OWN
 * {vendor}|{file_id} inbox key; a corrected sheet should use a fresh fileId
 * so it is not itself deduped away as a replay of the ORIGINAL failed file.
 */
export async function resolveIntakeException(
  db: FulfillmentDb,
  args: { exceptionId: string; correctedSheet: IntakeSheet; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean; result: IntakeResult | null }> {
  if (!isSheetStructurallyValid(args.correctedSheet)) {
    throw new OpsClientError('invalid', 'corrected sheet is structurally invalid (STEP B)')
  }

  let result: IntakeResult | null = null

  const ran = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_write')

    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:resolve-intake-exception'), async () => {
      result = await ingestIntakeSheetWithinTx(tx, args.correctedSheet, args.traceId)

      await tx.$executeRaw`
        UPDATE intake_exception
        SET resolved_at = now(), resolved_by_actor = ${args.actorId}::uuid
        WHERE id = ${args.exceptionId}::uuid AND resolved_at IS NULL
      `

      // Co-commit the ALLOW 6e (spec 10c CC-1): committed in the SAME tx as
      // the STEP-C re-ingest and the resolved-at stamp.
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:resolve-intake-exception',
            principalId: args.actorId,
            resourceIds: [args.exceptionId],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })

  return { deduped: !ran, result: ran ? result : null }
}

interface PriorArtifact {
  id: string
  asgnId: string
  btchId: string
  tenantId: string
  programId: string
  artifactType: string
  assetReference: string
  labelDisplayName: string
  labelQr: string
  bankConfigRef: string | null
}

async function resolvePriorArtifact(tx: Tx, asgnUuid: string, artifactType: string): Promise<PriorArtifact> {
  // Targeted by (asgn_id, artifact_type): an assignment normally carries
  // several non-superseded composed_artifact rows at once (one per
  // artifact_type: SOUNDBOX_IMG, STANDEE_IMG, STICKER_IMG), all inserted in
  // ONE transaction with an identical created_at (= transaction start). An
  // asgn_id-only ORDER BY created_at has no tiebreaker there and can select
  // the wrong sibling. Filtering on artifact_type too narrows this to
  // exactly one non-superseded row (the invariant each recompose preserves,
  // by superseding only the row of the type it just regenerated).
  const rows = await tx.$queryRaw<
    {
      id: string; asgn_id: string; btch_id: string; tenant_id: string; program_id: string
      artifact_type: string; asset_reference: string; label_display_name: string; label_qr: string
      bank_config_ref: string | null
    }[]
  >`
    SELECT id::text AS id, asgn_id::text AS asgn_id, btch_id::text AS btch_id, tenant_id::text AS tenant_id,
           program_id::text AS program_id, artifact_type, asset_reference, label_display_name, label_qr,
           bank_config_ref::text AS bank_config_ref
    FROM composed_artifact
    WHERE asgn_id = ${asgnUuid}::uuid AND artifact_type = ${artifactType} AND superseded_by IS NULL
  `
  if (rows.length === 0) throw new OpsClientError('not-found', 'composed_artifact not found for asgnId and artifactType')
  const r = rows[0]!
  return {
    id: r.id,
    asgnId: r.asgn_id,
    btchId: r.btch_id,
    tenantId: r.tenant_id,
    programId: r.program_id,
    artifactType: r.artifact_type,
    assetReference: r.asset_reference,
    labelDisplayName: r.label_display_name,
    labelQr: r.label_qr,
    bankConfigRef: r.bank_config_ref,
  }
}

/**
 * Re-composition (Task 7, check 4/D116 same-ship-to path): regenerates a
 * SINGLE composed_artifact row (of the caller-specified `artifactType`) for
 * the SAME ship-to only, per FR-08 ("regenerate a corrupted/failed/lost
 * artifact"). The target is resolved SERVER-SIDE as the one non-superseded
 * composed_artifact row for this (asgnId, artifactType); the program is read
 * off that same row, never a request body (M7/S16/D99).
 *
 * TARGET SELECTION (Critical 1 fix): an assignment normally holds MULTIPLE
 * non-superseded composed_artifact rows at once, one per artifact_type
 * (SOUNDBOX_IMG, STANDEE_IMG, STICKER_IMG), all inserted in the SAME
 * transaction and so sharing one created_at. Selecting by asgnId alone
 * (formerly `ORDER BY created_at DESC LIMIT 1`) has no tiebreaker among
 * siblings and can regenerate the wrong artifact_type. Requiring
 * `artifactType` on the call and filtering by it makes the target row
 * unique and deterministic; the regenerated row keeps that SAME
 * artifact_type (this is a regeneration of a specific artifact, not a type
 * change).
 *
 * SHIP-TO GUARD (Fork C): a `requestedShipTo` that differs from the CURRENT
 * `pending_pool_entry.ship_to_address` is rejected outright; the D116 reissue
 * path (a genuine address change) stays deferred. This function never reads
 * or writes `ship_to_superseded` / `superseded_ship_to`. A missing
 * pending_pool_entry row while `requestedShipTo` was supplied is ALSO a
 * throw (Minor 3 fix, fail-closed): there is no current ship-to to validate
 * against, so silently proceeding could apply a re-composition the caller
 * believed was ship-to-checked. When `requestedShipTo` is omitted there is
 * nothing to compare, so a missing pool entry is tolerated. The guard runs
 * INSIDE the onceWithin effect, so a rejection throws and rolls back the
 * whole transaction, including the inbox insert (E6): the clientKey is never
 * burned by a rejected attempt, and a corrected retry with the same clientKey
 * still works.
 *
 * The new row reuses the prior row's snapshot fields VERBATIM (asgn_id,
 * btch_id, tenant_id, program_id, artifact_type, asset_reference,
 * label_display_name, label_qr, bank_config_ref) under a fresh id; the prior
 * row is then marked superseded (superseded_by/superseded_at). composed_artifact
 * has NO updated_at column, so none is set.
 */
export async function recomposeArtifact(
  db: FulfillmentDb,
  args: {
    asgnId: string
    artifactType: string
    requestedShipTo?: string
    clientKey: string
    actorId: string
    traceId: string
  },
): Promise<{ deduped: boolean; artifactId: string | null }> {
  const asgnUuid = toUuid(args.asgnId)
  let newArtifactId: string | null = null

  const ran = await db.$transaction(async (tx: Tx) => {
    const prior = await resolvePriorArtifact(tx, asgnUuid, args.artifactType)
    await enterWriteScope(tx, 'fulfillment_write', prior.programId)

    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:recompose-artifact'), async () => {
      if (args.requestedShipTo !== undefined) {
        const shipToRows = await tx.$queryRaw<{ ship_to_address: string }[]>`
          SELECT ship_to_address FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid
        `
        const currentShipTo = shipToRows[0]?.ship_to_address
        if (currentShipTo === undefined) {
          throw new OpsClientError('invalid', 'pending_pool_entry not found for asgnId; cannot verify requested ship-to')
        }
        if (args.requestedShipTo !== currentShipTo) {
          throw new OpsClientError(
            'invalid',
            're-composition cannot change ship-to; a genuine ship-to change is a reissue (D116, deferred)',
          )
        }
      }

      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO composed_artifact
          (id, asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference, label_display_name, label_qr, bank_config_ref)
        VALUES
          (gen_random_uuid(), ${prior.asgnId}::uuid, ${prior.btchId}::uuid, ${prior.tenantId}::uuid, ${prior.programId}::uuid,
           ${prior.artifactType}, ${prior.assetReference}, ${prior.labelDisplayName}, ${prior.labelQr}, ${prior.bankConfigRef}::uuid)
        RETURNING id::text AS id
      `
      const mintedId = inserted[0]!.id
      newArtifactId = mintedId

      await tx.$executeRaw`
        UPDATE composed_artifact SET superseded_by = ${mintedId}::uuid, superseded_at = now()
        WHERE id = ${prior.id}::uuid
      `

      // Co-commit the ALLOW 6e (spec 10c CC-1): committed in the SAME tx as
      // the new-artifact INSERT and the supersede. resourceIds carry both the
      // assignment target and the minted artifact id (IDs only).
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:recompose-artifact',
            principalId: args.actorId,
            resourceIds: [args.asgnId, mintedId],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })

  return { deduped: !ran, artifactId: ran ? newArtifactId : null }
}

/**
 * record-HOLD as a class-3 ops action (check 3d sibling): resolves the
 * target's program server-side from `pending_pool_entry` (never a request
 * body), enters the write scope, then delegates the effect itself to the
 * injected-tx `holdEntryWithinTx` (Task 4) under a client-key dedup.
 *
 * Important 2 (intentional divergence, documented not changed): a missing
 * `pending_pool_entry` row THROWS here, even though `holdEntryWithinTx`
 * itself documents a missing row as an intentional no-op. That no-op is
 * correct for `holdEntryWithinTx`'s OTHER caller, an event-driven fact
 * consumer, where "nothing to hold" is a benign race with no operator
 * watching. This function is a human class-3 ops action against one
 * specific asgnId chosen by an operator; a not-found target there is an
 * operator-facing error, not a benign race, so it throws. The ops HTTP edge
 * (T9) maps this throw to a 4xx. This mirrors the same throw-on-not-found
 * policy `resolveProgramAndAwb` (T6) already uses elsewhere in this file.
 */
export async function holdRecord(
  db: FulfillmentDb,
  args: { asgnId: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean }> {
  const asgnUuid = toUuid(args.asgnId)

  const ran = await db.$transaction(async (tx: Tx) => {
    const rows = await tx.$queryRaw<{ program_id: string }[]>`
      SELECT program_id::text AS program_id FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid
    `
    if (rows.length === 0) throw new OpsClientError('not-found', 'pending_pool_entry not found for asgnId')
    await enterWriteScope(tx, 'fulfillment_write', rows[0]!.program_id)

    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:record-hold'), async () => {
      await holdEntryWithinTx(tx, args.asgnId, { operatorId: args.actorId })
      // Co-commit the ALLOW 6e (spec 10c CC-1) in the SAME tx as the hold.
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:record-hold',
            principalId: args.actorId,
            resourceIds: [args.asgnId],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })

  return { deduped: !ran }
}

/**
 * record-RELEASE (check 3d sibling): the reverse of record-HOLD, HELD ->
 * POOLED only (an already-POOLED or BATCHED row is left untouched, same
 * rowcount-gated pattern as holdEntryWithinTx). Stamps released_by_actor/
 * released_at. Step-up is enforced at the ops HTTP edge (Task 9), not here.
 *
 * Important 2 (intentional divergence, documented not changed): same
 * rationale as `holdRecord` above, a missing `pending_pool_entry` row
 * THROWS here (operator-facing error on a specific asgnId, mapped to a 4xx
 * at the T9 edge), distinct from `holdEntryWithinTx`'s own no-op-on-missing
 * behavior for its event-driven caller. This is not a bug to fix, it is the
 * throw-on-not-found policy this file already applies via
 * `resolveProgramAndAwb` (T6).
 */
export async function releaseRecord(
  db: FulfillmentDb,
  args: { asgnId: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean; released: boolean }> {
  const asgnUuid = toUuid(args.asgnId)
  let released = false

  const ran = await db.$transaction(async (tx: Tx) => {
    const rows = await tx.$queryRaw<{ program_id: string }[]>`
      SELECT program_id::text AS program_id FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid
    `
    if (rows.length === 0) throw new OpsClientError('not-found', 'pending_pool_entry not found for asgnId')
    await enterWriteScope(tx, 'fulfillment_write', rows[0]!.program_id)

    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:record-release'), async () => {
      const count = await tx.$executeRaw`
        UPDATE pending_pool_entry
        SET pool_status = 'POOLED', released_by_actor = ${args.actorId}::uuid, released_at = now(), updated_at = now()
        WHERE asgn_id = ${asgnUuid}::uuid AND pool_status = 'HELD'
      `
      released = count > 0
      // Co-commit the ALLOW 6e (spec 10c CC-1) in the SAME tx as the release.
      // The operator's privileged release action is audited whenever the
      // client-key callback runs (once, never on a replay), independent of
      // whether the row was in the HELD state to transition (`released`).
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:record-release',
            principalId: args.actorId,
            resourceIds: [args.asgnId],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })

  return { deduped: !ran, released }
}

/**
 * The MANUAL batch trigger as a class-3 ops action (check 3c/7 sibling): the
 * program is a caller-supplied programWire here (not resolved from a target
 * row, there is none), still converted server-side to its uuid form for the
 * write scope.
 *
 * OUTER onceWithin (spec 10c CC-1b / S15-T2 ruling): wraps BOTH the
 * `triggerBatchWithinTx` call and the ALLOW 6e emit, keyed by
 * `instanceKey(clientKey, 'ops:manual-batch-trigger')` via the shared E6
 * inbox. A same-client-key REPLAY is suppressed by THIS outer dedup: the
 * callback never re-runs, so `triggerBatchWithinTx` is never re-invoked and no
 * second 6e is emitted. `triggerBatchWithinTx`'s OWN inner onceWithin (keyed
 * `batch|{tenant}|{program}|MANUAL|{epoch}` with `epoch = clientKey`) still
 * exists and still runs on the FIRST call; it is harmlessly redundant here
 * (it still matters for `triggerBatchWithinTx`'s other, non-ops callers) and
 * is simply never reached on a replay because the outer callback does not
 * re-enter.
 *
 * The ALLOW 6e is emitted UNCONDITIONALLY inside the outer callback,
 * regardless of whether a batch was actually born: an empty-pool authorized
 * trigger is still an authorized, audited attempt (S15/T2), so the 6e does
 * not depend on `triggerBatchWithinTx`'s return value. `resourceIds` includes
 * the minted btchId only when one exists (IDs only; there is nothing to add
 * when no batch was born).
 *
 * The BRD 5.3.4 force-dispatch REASON does not appear in that 6e at all, and
 * that is deliberate: the record is IDs and enums, so the free-text reason is
 * never appended to `resourceIds` (which would smuggle prose into an id list)
 * and never added as a field. It lives on `batch.trigger_note` only, exactly as
 * `overrideTerminal`'s free text lives only on
 * `shpt_status_event.override_reason` (DD1). The emitted ALLOW is byte-identical
 * to what it was before the reason existed.
 *
 * Returns the `triggerBatchWithinTx` result on a first run, and `null` on a
 * same-clientKey replay (the outer dedup form), matching the prior return
 * contract the ops HTTP edge (T9, `apps/ops-edge/src/ops.controller.ts`)
 * already expects (`{ btchId } | null`, returned directly with no `deduped`
 * field).
 */
type ManualBatchResult = { btchId: string; unitCount: number } | null

// BRD 5.3.4: the cap on the force-dispatch reason. 500 characters is the same
// order as any other operator note field and exists so a paste of a whole email
// thread (or a script) cannot write an unbounded string into the domain row. The
// reason is stored, never interpolated into SQL (it rides as a bound parameter)
// and never logged, so this is a size bound, not a sanitiser.
const MAX_TRIGGER_NOTE_LENGTH = 500

export async function manualBatch(
  db: FulfillmentDb,
  args: {
    tenantWire: string
    programWire: string
    // BRD 5.3.4: REQUIRED, unlike every other field the trigger takes. A manual
    // batch is an operator overriding the pool's own lot-size economics, and
    // the reason is the whole point of auditing it. Stored on batch.trigger_note
    // (the shpt_status_event.override_reason precedent); deliberately NOT added
    // to the ALLOW 6e below, which stays IDs-only (DD1).
    reason: string
    clientKey: string
    actorId: string
    traceId: string
  },
): Promise<{ btchId: string } | null> {
  // Validated HERE as well as at the edge, and before anything else runs: the
  // edge check is the one that produces a good operator-facing message, this one
  // is the domain's own guarantee that no MANUAL batch row is ever written with
  // a blank or unbounded note, whichever caller invoked it. Same shape as
  // overrideTerminal's own override_reason check above.
  const reason = args.reason.trim()
  if (reason === '') throw new OpsClientError('invalid', 'trigger reason required')
  if (reason.length > MAX_TRIGGER_NOTE_LENGTH) {
    throw new OpsClientError('invalid', `trigger reason must be at most ${MAX_TRIGGER_NOTE_LENGTH} characters`)
  }

  const programUuid = toUuid(args.programWire)

  // The transaction callback is given an EXPLICIT return type annotation
  // (`Promise<[boolean, ManualBatchResult]>`) so the tuple escapes with its
  // declared type, not the narrowed-to-null flow type TS would otherwise infer
  // for `batchResult` at its declaration (a variable only ever reassigned from
  // within a nested onceWithin closure). Without the annotation, TS narrows
  // the post-transaction `batchResult` reference to `never` on the
  // `!== null` branch below, a known control-flow-analysis limitation for
  // closure-captured variables, not a real type hazard.
  const [ran, batchResult] = await db.$transaction(
    async (tx: Tx): Promise<[boolean, ManualBatchResult]> => {
      await enterWriteScope(tx, 'fulfillment_write', programUuid)
      let batchResult: ManualBatchResult = null
      const ran = await onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:manual-batch-trigger'), async () => {
        batchResult = await triggerBatchWithinTx(tx, args.tenantWire, args.programWire, 'MANUAL', {
          epoch: args.clientKey,
          actorUuid: args.actorId,
          // The TRIMMED reason, written to batch.trigger_note in the same
          // transaction as the batch itself and the ALLOW 6e below.
          triggerNote: reason,
        })
        // Co-commit the ALLOW 6e (spec 10c CC-1b / S15-T2 ruling): unconditional,
        // regardless of whether a batch was born. This callback only runs on a
        // fresh clientKey (the OUTER onceWithin above dedups a replay before it
        // ever reaches here), so exactly one ALLOW is emitted per authorized
        // attempt, never per replay.
        await enqueue(
          tx,
          buildAuthzAuditEvent(
            opsAllow({
              operation: 'ops:manual-batch-trigger',
              principalId: args.actorId,
              resourceIds:
                batchResult !== null
                  ? [args.tenantWire, args.programWire, batchResult.btchId]
                  : [args.tenantWire, args.programWire],
              traceId: args.traceId,
            }),
          ),
        )
      })
      return [ran, batchResult]
    },
  )

  return ran && batchResult !== null ? { btchId: batchResult.btchId } : null
}

/**
 * Vendor suspend (check 3e sibling): vndr is PLATFORM-ONLY (no program_id,
 * permissive FORCE RLS, `vndr_v1` USING(true)/WITH CHECK(true)), so this
 * enters the write role bare, with no program to set. Step-up is enforced at
 * the ops HTTP edge (Task 9), not here.
 */
export async function suspendVendor(
  db: FulfillmentDb,
  args: { vndrId: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean }> {
  const vndrUuid = toUuid(args.vndrId)

  const ran = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_write')
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:vendor-suspend'), async () => {
      await tx.$executeRaw`
        UPDATE vndr SET status = 'SUSPENDED', updated_at = now() WHERE id = ${vndrUuid}::uuid
      `
      // Co-commit the ALLOW 6e (spec 10c CC-1) in the SAME tx as the suspend.
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:vendor-suspend',
            principalId: args.actorId,
            resourceIds: [args.vndrId],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })

  return { deduped: !ran }
}

/**
 * Vendor create as a class-3 ops action (Task 9 wrapper): the thin ops
 * counterpart to `createVendor`, the one that carries the client-key
 * idempotency the ops HTTP edge (T9) requires (Fork D). vndr is PLATFORM-ONLY
 * (no program_id, permissive FORCE RLS), so this enters the write role bare,
 * with no program to set, exactly like `suspendVendor` above, then runs the
 * SAME `createVendorWithinTx` effect the non-ops `createVendor` uses, under a
 * `onceWithin` keyed by the client-supplied action key, so a replay of the same
 * clientKey does not create a second vendor. Step-up is not required for create
 * (it is not in OPS_STEP_UP_CATALOG); the edge enforces authz there.
 *
 * `deduped: true` means this call was a client-key replay (the E6 inbox already
 * created the vendor on the original call); `vndrId` is only meaningful when
 * `deduped` is false and is `null` on a replay (the created id is not re-derived
 * from a dedup, mirroring the other ops wrappers in this file).
 */
export async function createVendorOps(
  db: FulfillmentDb,
  args: {
    type: string
    displayName: string
    // Phase 3 Task 2 (BRD FR-11): both optional, COURIER-applicable only.
    courierCode?: string
    integrationMode?: string
    clientKey: string
    actorId: string
    traceId: string
  },
): Promise<{ deduped: boolean; vndrId: string | null }> {
  let vndrId: string | null = null

  let ran: boolean
  try {
    ran = await db.$transaction(async (tx: Tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_write')
      return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:vendor-create'), async () => {
        const res = await createVendorWithinTx(
          tx,
          {
            type: args.type,
            displayName: args.displayName,
            ...(args.courierCode !== undefined ? { courierCode: args.courierCode } : {}),
            ...(args.integrationMode !== undefined ? { integrationMode: args.integrationMode } : {}),
          },
          { operatorId: args.actorId },
          args.traceId,
        )
        vndrId = res.vndrId
        // Co-commit the ALLOW 6e (spec 10c CC-1) in the SAME tx as the create.
        // The minted vendor id is the target resource (IDs only).
        await enqueue(
          tx,
          buildAuthzAuditEvent(
            opsAllow({
              operation: 'ops:vendor-create',
              principalId: args.actorId,
              resourceIds: [res.vndrId],
              traceId: args.traceId,
            }),
          ),
        )
      })
    })
  } catch (err) {
    // A duplicate courierCode (courier_code is @unique on vndr) is an expected
    // client condition, not a server fault: map it to a clean 4xx via
    // OpsClientError rather than letting the raw constraint error reach the
    // edge as a 500 (mirrors tms/src/ops.ts's createDamageReasonOps). The
    // transaction rolled back (no partial row, no orphaned 6e).
    if (isRawUniqueViolation(err)) {
      throw new OpsClientError('invalid', 'a vendor with this courier code already exists')
    }
    throw err
  }

  return { deduped: !ran, vndrId: ran ? vndrId : null }
}

/**
 * Vendor edit (Phase 3 Task 2, BRD FR-11): the courier master edit,
 * addressed by the WIRE vndrId, mirroring `suspendVendor`/`createVendorOps`'s
 * bare-role pattern (vndr is PLATFORM-ONLY, no program to set). Every field
 * (displayName, courierCode, integrationMode) is independently optional (a
 * partial edit; `updateVendorWithinTx`'s COALESCE keeps whatever the caller
 * omits). A not-found target throws OpsClientError('not-found', ...) INSIDE
 * the onceWithin effect, so the whole transaction (including the E6 inbox
 * insert) rolls back and the clientKey is never burned by a rejected attempt,
 * same idiom as `recomposeArtifact`'s ship-to guard. Step-up is not required
 * (not in OPS_STEP_UP_CATALOG), matching create's own no-step-up posture:
 * this is master-data maintenance, not a destructive vendor/shipment action.
 */
export async function editVendorOps(
  db: FulfillmentDb,
  args: {
    vndrId: string
    displayName?: string
    courierCode?: string
    integrationMode?: string
    clientKey: string
    actorId: string
    traceId: string
  },
): Promise<{ deduped: boolean }> {
  let ran: boolean
  try {
    ran = await db.$transaction(async (tx: Tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_write')
      return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:vendor-edit'), async () => {
        const updated = await updateVendorWithinTx(tx, args.vndrId, {
          ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
          ...(args.courierCode !== undefined ? { courierCode: args.courierCode } : {}),
          ...(args.integrationMode !== undefined ? { integrationMode: args.integrationMode } : {}),
        })
        if (updated === null) throw new OpsClientError('not-found', 'vndr not found')

        // Co-commit the ALLOW 6e (spec 10c CC-1) in the SAME tx as the edit.
        await enqueue(
          tx,
          buildAuthzAuditEvent(
            opsAllow({
              operation: 'ops:vendor-edit',
              principalId: args.actorId,
              resourceIds: [args.vndrId],
              traceId: args.traceId,
            }),
          ),
        )
      })
    })
  } catch (err) {
    // A duplicate courierCode is an expected client condition, not a server
    // fault (same mapping as createVendorOps above). The transaction rolled
    // back (no partial row, no orphaned 6e).
    if (isRawUniqueViolation(err)) {
      throw new OpsClientError('invalid', 'a vendor with this courier code already exists')
    }
    throw err
  }

  return { deduped: !ran }
}

// Phase 3 Task 5b (BRD Annexure D.4): the bank/branch composition-config admin
// write path. bank_composition_config is TENANT-KEYED reference data, not
// program-scoped (its own RLS policy, "bank_composition_config_v1", is
// USING(true) WITH CHECK(true), unscoped by design -- see the schema.prisma
// comment), so both ops functions below enter the write role BARE
// (enterWriteRole, no program to set), exactly like createVendorOps/vndr. The
// composite key is (tenantId, bankCode, branchCode); branchCode defaults to
// the T5a '' sentinel for a bank-level default row (never null, matching the
// resolver's own fallback in dispatch.ts).
export interface UpsertBankCompositionConfigInput {
  tenantWire: string
  bankCode: string
  // Omitted -> the '' bank-level-default sentinel (T5a); pass an explicit
  // branch code to address (or create) a branch-specific row.
  branchCode?: string
  brandingParams: unknown
  imageTemplates: unknown
  clientKey: string
  actorId: string
  traceId: string
}

/**
 * Upsert brandingParams + imageTemplates for a (tenant, bank, branch) key.
 * A true upsert on the row's own natural key: INSERT ... ON CONFLICT (tenant_id,
 * bank_code, branch_code) DO UPDATE, so create and edit are the SAME call
 * (mirrors the brief's "upsert", not the separate create/edit pair
 * createVendorOps/editVendorOps use for vndr, which has no natural key to
 * upsert on). Because the ON CONFLICT target IS the table's only unique
 * constraint, this can never itself raise a 23505 duplicate -- there is no
 * isRawUniqueViolation catch here for that reason (unlike createVendorOps/
 * editVendorOps, which address vndr by a SEPARATE surrogate id and so can
 * collide on the courier_code side-unique). logoMasterRef/logoDerivativeRef
 * are NEVER touched here (a fresh row is born with both null; an existing
 * row's logo fields are left exactly as they are) -- the logo lives on its
 * own path, setBankLogo below.
 */
export async function upsertBankCompositionConfig(
  db: FulfillmentDb,
  args: UpsertBankCompositionConfigInput,
): Promise<{ deduped: boolean; id: string | null }> {
  const tenantUuid = toUuid(args.tenantWire)
  const branchCode = args.branchCode ?? ''
  const brandingParamsJson = JSON.stringify(args.brandingParams ?? {})
  const imageTemplatesJson = JSON.stringify(args.imageTemplates ?? {})

  let id: string | null = null
  const ran = await db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'fulfillment_write')
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:bank-config-upsert'), async () => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO bank_composition_config (id, tenant_id, bank_code, branch_code, branding_params, image_templates, updated_at)
        VALUES (gen_random_uuid(), ${tenantUuid}::uuid, ${args.bankCode}, ${branchCode}, ${brandingParamsJson}::jsonb, ${imageTemplatesJson}::jsonb, now())
        ON CONFLICT (tenant_id, bank_code, branch_code)
        DO UPDATE SET branding_params = EXCLUDED.branding_params, image_templates = EXCLUDED.image_templates, updated_at = now()
        RETURNING id::text AS id
      `
      id = rows[0]!.id

      // Co-commit the ALLOW 6e (S15/T2 ruling) in the SAME tx as the upsert.
      // The row id is the target resource (IDs only).
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:template-config-set',
            principalId: args.actorId,
            resourceIds: [id],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })

  return { deduped: !ran, id: ran ? id : null }
}

export interface SetBankLogoInput {
  tenantWire: string
  bankCode: string
  branchCode?: string
  bytes: Uint8Array
  contentType: string
  filename: string
  clientKey: string
  actorId: string
  traceId: string
}

/**
 * Store a new bank/branch logo via the T3 AssetStore port and persist the
 * returned reference into logoMasterRef, nulling logoDerivativeRef
 * (rasterization is deferred -- see the schema.prisma comment on both
 * columns). Creates the config row if it does not already exist (a logo can
 * be the FIRST write for a (tenant, bank, branch), before any branding/
 * template upsert), otherwise updates the existing row in place, leaving
 * brandingParams/imageTemplates untouched.
 *
 * The AssetStore `key` is the bank/branch CODE ONLY -- never the tenantId,
 * actorId, or any PII (S4; the T3 dev reference embeds the key in plaintext,
 * so a PII key would leak PII into a logged/persisted reference). A
 * branch-specific upload keys on "{bankCode}/{branchCode}"; the bank-level
 * default ('' branchCode) keys on the bare bankCode, so it never collides
 * with a real branch code of the same bank.
 *
 * `assetStore.put()` runs INSIDE the onceWithin effect (after the client-key
 * dedup check), not before: a replay of the same clientKey must never mint a
 * second asset version (T3 semantics: a second put() supersedes but keeps
 * history), so the put has to happen only on a genuinely fresh attempt, same
 * ordering discipline as the domain row write and the co-committed 6e.
 *
 * The 6e carries the new version alongside the row id in resourceIds (IDs/
 * enums only, S7/S10.5): a version token (T3: "opaque-but-orderable", e.g.
 * "v3") is exactly such an enum-like short token, never free text or PII, so
 * it rides the audit tagged as "logo-version:<version>" rather than needing a
 * new free-text field on AuthzAuditRecord.
 */
export async function setBankLogo(
  db: FulfillmentDb,
  assetStore: AssetStore,
  args: SetBankLogoInput,
): Promise<{ deduped: boolean; id: string | null; reference: string | null; version: string | null }> {
  const tenantUuid = toUuid(args.tenantWire)
  const branchCode = args.branchCode ?? ''
  const assetKey = branchCode === '' ? args.bankCode : `${args.bankCode}/${branchCode}`

  let id: string | null = null
  let reference: string | null = null
  let version: string | null = null
  const ran = await db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'fulfillment_write')
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:bank-logo-set'), async () => {
      const put = await assetStore.put(assetKey, args.bytes, {
        contentType: args.contentType,
        filename: args.filename,
      })
      reference = put.reference
      version = put.version

      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO bank_composition_config (id, tenant_id, bank_code, branch_code, logo_master_ref, logo_derivative_ref, branding_params, image_templates, updated_at)
        VALUES (gen_random_uuid(), ${tenantUuid}::uuid, ${args.bankCode}, ${branchCode}, ${put.reference}, NULL, '{}'::jsonb, '{}'::jsonb, now())
        ON CONFLICT (tenant_id, bank_code, branch_code)
        DO UPDATE SET logo_master_ref = EXCLUDED.logo_master_ref, logo_derivative_ref = NULL, updated_at = now()
        RETURNING id::text AS id
      `
      id = rows[0]!.id

      // Co-commit the ALLOW 6e (S15/T2 ruling) in the SAME tx as the write.
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:bank-logo-set',
            principalId: args.actorId,
            resourceIds: [id, `logo-version:${put.version}`],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })

  return {
    deduped: !ran,
    id: ran ? id : null,
    reference: ran ? reference : null,
    version: ran ? version : null,
  }
}

export interface SetBankTemplateMasterInput {
  tenantWire: string
  bankCode: string
  branchCode?: string
  // The M2 ruling (2026-08-10 meeting): one row carries TWO masters, one per
  // dispatch package half, never a third. A closed union, not a free string,
  // so an unknown group can never reach the column-selection branch below.
  group: 'SOUNDBOX' | 'COLLATERAL'
  bytes: Uint8Array
  contentType: string
  filename: string
  clientKey: string
  actorId: string
  traceId: string
}

/**
 * Store a new bank/branch dispatch-artwork master (the vendor-artwork PDF a
 * bank supplies once per group) and persist the returned reference into
 * soundboxTemplateRef or collateralTemplateRef, whichever `args.group`
 * selects, exactly mirroring setBankLogo's own create-or-update-in-place
 * shape (same composite key, same AssetStore port, same co-committed 6e).
 * Unlike setBankLogo, there is no paired NULL-out of a sibling column: the
 * OTHER group's ref is a live, independently-uploaded master and must be left
 * exactly as it is on every write here (see the two explicit $queryRaw
 * variants below).
 *
 * TWO checks run BEFORE any transaction opens, so a reject never consumes the
 * client key (rule 1, 06.A: a clientKey belongs to the attempt that actually
 * ran, not to one that was refused at the door):
 *
 * 1. `template_not_pdf`: the candidate bytes must parse as a PDF with at
 *    least one page. pdf-lib is already the renderer's dependency
 *    (package.ts), so parsing here invents no new capability.
 * 2. `template_trim_mismatch`: M2's one-shared-trim guarantee. The two
 *    masters of one (tenant, bank, branch) row must share one page box, or
 *    the vendor gets two files of unequal trim in the same dispatch package.
 *    This reads the OTHER group's ref off the EXACT row (tenant_id, bank_code,
 *    branch_code), never a fallback chain (a branch row with no master of its
 *    own is not compared against the bank-level default), loads it via
 *    assetStore.getByReference, and compares page boxes to within 0.01 pt.
 *    Composition (dispatch.ts) checks again at compose time; this check
 *    exists so the operator hears about a mismatch at upload, not at compose.
 *
 * The AssetStore `key` is `template/<group>/<bankCode-or-bankCode/branchCode>`
 * -- codes only, never the tenantId, actorId, or any PII (S4), same
 * bankCode-or-bankCode/branch expression setBankLogo builds, namespaced under
 * the group so a bank's soundbox and collateral masters never collide on one
 * key. `assetStore.put()` runs INSIDE the onceWithin effect, after the
 * client-key dedup check and after both preflight checks have already passed,
 * for the same reason setBankLogo's put() does: a replay of the same
 * clientKey must never mint a second asset version.
 *
 * The 6e carries the row id, the new version, and the group (S7/S10.5
 * IDs-and-enums only): `[id, 'template-version:' + put.version, args.group]`.
 */
export async function setBankTemplateMaster(
  db: FulfillmentDb,
  assetStore: AssetStore,
  args: SetBankTemplateMasterInput,
): Promise<{ deduped: boolean; id: string | null; reference: string | null; version: string | null }> {
  const tenantUuid = toUuid(args.tenantWire)
  const branchCode = args.branchCode ?? ''

  // Check 1 (template_not_pdf): the candidate must parse as a PDF with a
  // readable first page. A caught load failure or a zero-page document are
  // both treated as "not a PDF" -- neither has a page box to compare or ship.
  // Fix wave 2 Finding 2: the reject now carries its code through
  // OpsClientError.reasons (the same channel device-inventory-adapter's
  // structural errors already ride), so the 400 is machine-readable rather
  // than a bare "invalid request" indistinguishable from every other reject
  // on this door.
  const candidate = await PDFDocument.load(args.bytes).catch(() => null)
  if (candidate === null || candidate.getPageCount() === 0) {
    throw new OpsClientError('invalid', 'template_not_pdf', [{ code: 'template_not_pdf' }])
  }
  const candidateBox = { w: candidate.getPage(0)!.getWidth(), h: candidate.getPage(0)!.getHeight() }

  // Check 1b (template_rotated, Finding 3, cheap door hardening): a designer
  // PDF saved with a page /Rotate other than 0 embeds unrotated (pdf-lib's
  // embedPdf does not bake /Rotate into the drawn box) and would ship SIDEWAYS
  // at swapped effective dimensions once composed into the group PDF. Reading
  // page 0's own rotation is exactly what pdf-lib exposes for this (no new
  // dependency), and rejecting it at the door is far cheaper than a print
  // vendor discovering a sideways standee. Checked here, after the PDF parses
  // but before the trim comparison, because a rotated master has nothing
  // meaningful to compare trims against anyway.
  if (candidate.getPage(0)!.getRotation().angle !== 0) {
    throw new OpsClientError('invalid', 'template_rotated', [{ code: 'template_rotated' }])
  }

  // Check 2 (template_trim_mismatch): read ONLY the other group's ref off this
  // EXACT row (fulfillment_ops_read, bare -- bank_composition_config is
  // unscoped platform reference data, same posture as listVendors above), no
  // program to set. A row that does not exist yet, or exists with the other
  // column still NULL, has nothing to compare against and is accepted.
  const otherRows =
    args.group === 'SOUNDBOX'
      ? await db.$transaction(async (tx: Tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
          return tx.$queryRaw<{ ref: string | null }[]>`
            SELECT collateral_template_ref AS ref FROM bank_composition_config
            WHERE tenant_id = ${tenantUuid}::uuid AND bank_code = ${args.bankCode} AND branch_code = ${branchCode}
          `
        })
      : await db.$transaction(async (tx: Tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
          return tx.$queryRaw<{ ref: string | null }[]>`
            SELECT soundbox_template_ref AS ref FROM bank_composition_config
            WHERE tenant_id = ${tenantUuid}::uuid AND bank_code = ${args.bankCode} AND branch_code = ${branchCode}
          `
        })
  const otherRef = otherRows[0]?.ref ?? null
  if (otherRef !== null) {
    const otherAsset = await assetStore.getByReference(otherRef)
    // A stored ref that no longer resolves cannot be compared; that is a
    // separate integrity concern from this upload path, not this check's job.
    if (otherAsset !== null) {
      const otherDoc = await PDFDocument.load(otherAsset.bytes).catch(() => null)
      if (otherDoc !== null && otherDoc.getPageCount() > 0) {
        const otherBox = { w: otherDoc.getPage(0)!.getWidth(), h: otherDoc.getPage(0)!.getHeight() }
        const widthOff = Math.abs(otherBox.w - candidateBox.w) > 0.01
        const heightOff = Math.abs(otherBox.h - candidateBox.h) > 0.01
        if (widthOff || heightOff)
          throw new OpsClientError('invalid', 'template_trim_mismatch', [{ code: 'template_trim_mismatch' }])
      }
    }
  }

  const codeKey = branchCode === '' ? args.bankCode : `${args.bankCode}/${branchCode}`
  const assetKey = `template/${args.group}/${codeKey}`

  let id: string | null = null
  let reference: string | null = null
  let version: string | null = null
  const ran = await db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'fulfillment_write')
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:bank-template-master-set'), async () => {
      const put = await assetStore.put(assetKey, args.bytes, {
        contentType: args.contentType,
        filename: args.filename,
      })
      reference = put.reference
      version = put.version

      // Column names are never interpolated into SQL (S23): two explicit
      // statements, chosen by the group, each setting only ITS OWN column on
      // conflict. The sibling column is left untouched on both the fresh
      // INSERT (its VALUES slot is NULL, discarded by Postgres on conflict
      // anyway) and the DO UPDATE (simply absent from the SET list).
      const rows =
        args.group === 'SOUNDBOX'
          ? await tx.$queryRaw<{ id: string }[]>`
              INSERT INTO bank_composition_config (id, tenant_id, bank_code, branch_code, soundbox_template_ref, collateral_template_ref, branding_params, image_templates, updated_at)
              VALUES (gen_random_uuid(), ${tenantUuid}::uuid, ${args.bankCode}, ${branchCode}, ${put.reference}, NULL, '{}'::jsonb, '{}'::jsonb, now())
              ON CONFLICT (tenant_id, bank_code, branch_code)
              DO UPDATE SET soundbox_template_ref = EXCLUDED.soundbox_template_ref, updated_at = now()
              RETURNING id::text AS id
            `
          : await tx.$queryRaw<{ id: string }[]>`
              INSERT INTO bank_composition_config (id, tenant_id, bank_code, branch_code, soundbox_template_ref, collateral_template_ref, branding_params, image_templates, updated_at)
              VALUES (gen_random_uuid(), ${tenantUuid}::uuid, ${args.bankCode}, ${branchCode}, NULL, ${put.reference}, '{}'::jsonb, '{}'::jsonb, now())
              ON CONFLICT (tenant_id, bank_code, branch_code)
              DO UPDATE SET collateral_template_ref = EXCLUDED.collateral_template_ref, updated_at = now()
              RETURNING id::text AS id
            `
      id = rows[0]!.id

      // Co-commit the ALLOW 6e (S15/T2 ruling) in the SAME tx as the write.
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:bank-template-master-set',
            principalId: args.actorId,
            resourceIds: [id, `template-version:${put.version}`, args.group],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })

  return {
    deduped: !ran,
    id: ran ? id : null,
    reference: ran ? reference : null,
    version: ran ? version : null,
  }
}

// Phase 3 Task 6 (BRD 5.3.2): the admin-writable batching-parameter store
// (Minimum Lot Size + Maximum Wait Time), revising S23's code-as-config.
// batching_config is platform master data (permissive FORCE RLS, unscoped by
// program -- see its "batching_config_v1" policy), so this enters the write
// role BARE (enterWriteRole, no program to set), exactly like
// upsertBankCompositionConfig / createVendorOps. The scope key is
// (tenantWire, programWire) with the '' sentinel: both omitted -> the GLOBAL
// default row; tenantWire only -> a per-tenant default; both -> a
// per-(tenant, program) override.
export interface UpsertBatchingConfigInput {
  // Both omitted -> GLOBAL default; tenantWire only -> per-tenant default;
  // both -> per-(tenant, program) override. A programWire without a tenantWire
  // is invalid (there is no program-only batching scope). These scope-key
  // fields ARE legitimate request inputs (platform master data an AndPayments
  // admin configures, not principal-scoped tenant data, unlike M7/S16); the
  // actor / traceId / idempotency-key still come from the gate, never here.
  tenantWire?: string
  programWire?: string
  minLotSize: number
  maxWaitSeconds: number
  clientKey: string
  actorId: string
  traceId: string
}

/**
 * Upsert the batching parameters for one scope, co-committing the ALLOW 6e WITH
 * the OLD and NEW values (BRD 271). A true upsert on the scope's natural key:
 * INSERT ... ON CONFLICT (tenant_wire, program_wire) DO UPDATE, so create and
 * edit are the SAME call (mirrors upsertBankCompositionConfig, not the separate
 * create/edit pair vndr uses). Because the ON CONFLICT target IS the table's
 * only unique constraint, this can never itself raise a 23505 (no
 * isRawUniqueViolation catch is needed).
 *
 * VALIDATION (BRD 5.3.2): both minLotSize and maxWaitSeconds must be integers
 * >= 1; an invalid value throws OpsClientError('invalid') (a 4xx at the edge)
 * BEFORE any transaction opens, so an invalid request never burns a clientKey.
 *
 * AUDIT (BRD 271): the co-committed ALLOW 6e carries the row id, the scope
 * (an enum-like token plus the wire ids, when present), and the OLD and NEW
 * values as enum-like integer tokens (S7/S10.5 IDs-and-enums only, the same
 * technique setBankLogo uses for logo-version). The OLD value for a
 * first-time write on a scope is the code DEFAULT (an EMPTY batching_config
 * reproduces 50 / 7 days, so that DEFAULT is the value that was effectively in
 * force). The actor (principalId) and the record's own committed timestamp
 * complete the BRD-mandated (user, timestamp, old value, new value) tuple. The
 * free-form values never ride the record as free text; they are short numeric
 * tokens only.
 */
export async function upsertBatchingConfig(
  db: FulfillmentDb,
  args: UpsertBatchingConfigInput,
): Promise<{ deduped: boolean; id: string | null }> {
  if (args.programWire !== undefined && args.tenantWire === undefined) {
    throw new OpsClientError('invalid', 'programWire requires tenantWire (there is no program-only batching scope)')
  }
  if (!Number.isInteger(args.minLotSize) || args.minLotSize < 1) {
    throw new OpsClientError('invalid', 'minLotSize must be an integer >= 1')
  }
  if (!Number.isInteger(args.maxWaitSeconds) || args.maxWaitSeconds < 1) {
    throw new OpsClientError('invalid', 'maxWaitSeconds must be an integer >= 1')
  }

  const tenantWire = args.tenantWire ?? ''
  const programWire = args.programWire ?? ''
  const scopeResourceIds =
    tenantWire === ''
      ? ['scope:global']
      : programWire === ''
        ? ['scope:tenant', tenantWire]
        : ['scope:tenant-program', tenantWire, programWire]

  let id: string | null = null
  const ran = await db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'fulfillment_write')
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:batching-config-set'), async () => {
      // Capture the OLD values for this exact scope (BRD 271). A scope with no
      // explicit row was effectively running on the code DEFAULT, so that
      // DEFAULT is the correct "old value" to audit for a first-time write.
      const prior = await tx.$queryRaw<{ min_lot_size: number; max_wait_seconds: number }[]>`
        SELECT min_lot_size, max_wait_seconds FROM batching_config
        WHERE tenant_wire = ${tenantWire} AND program_wire = ${programWire}
      `
      const oldMin = prior[0] !== undefined ? Number(prior[0].min_lot_size) : DEFAULT_POOL_CFG.minLotSize
      const oldMax = prior[0] !== undefined ? Number(prior[0].max_wait_seconds) : DEFAULT_POOL_CFG.maxWaitSeconds

      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO batching_config (id, tenant_wire, program_wire, min_lot_size, max_wait_seconds, updated_at)
        VALUES (gen_random_uuid(), ${tenantWire}, ${programWire}, ${args.minLotSize}, ${args.maxWaitSeconds}, now())
        ON CONFLICT (tenant_wire, program_wire)
        DO UPDATE SET min_lot_size = EXCLUDED.min_lot_size, max_wait_seconds = EXCLUDED.max_wait_seconds, updated_at = now()
        RETURNING id::text AS id
      `
      id = rows[0]!.id

      // Co-commit the ALLOW 6e (S15/T2 ruling) in the SAME tx as the upsert,
      // carrying old + new (BRD 271) as enum-like integer tokens.
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:batching-config-set',
            principalId: args.actorId,
            resourceIds: [
              id,
              ...scopeResourceIds,
              `min-lot-size:old=${oldMin}:new=${args.minLotSize}`,
              `max-wait-seconds:old=${oldMax}:new=${args.maxWaitSeconds}`,
            ],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })

  return { deduped: !ran, id: ran ? id : null }
}
