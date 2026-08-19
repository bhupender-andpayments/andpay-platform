import { fromUuid, toUuid } from '@andpay/ids'
import type { FulfillmentDb } from './db.js'
import type { Tx } from './internal.js'

// The ops-portal vendor list (Task 7, check 3e sibling). vndr is PLATFORM-ONLY
// (no program_id), so this enters the ops read role bare, with no program
// scope to set; the fulfillment_ops_read grants/policies (Task 6) give broad
// operator visibility (USING(true) on vndr, matching vndr_v1's own permissive
// policy). role is a compile-time constant, never user input (safe to inline
// into $executeRawUnsafe, same reasoning as enterWriteScope/enterReadScope).
//
// NO aggregate here (a later guard scans this file): a plain row-list SELECT
// only.
export interface VendorRow {
  id: string
  type: string
  displayName: string
  status: string
  courierCode: string | null
  createdAt: Date
  updatedAt: Date
}

interface VendorDbRow {
  id: string
  type: string
  display_name: string
  status: string
  courier_code: string | null
  created_at: Date
  updated_at: Date
}

function toVendorDto(r: VendorDbRow): VendorRow {
  return {
    id: fromUuid('vndr', r.id),
    type: r.type,
    displayName: r.display_name,
    status: r.status,
    courierCode: r.courier_code,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function listVendors(db: FulfillmentDb): Promise<VendorRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    return tx.$queryRaw<VendorDbRow[]>`
      SELECT id, type, display_name, status, courier_code, created_at, updated_at
      FROM vndr
      ORDER BY created_at
    `
  })
  return rows.map(toVendorDto)
}

// The two fulfillment exception surfaces (spec 10c Task 8, check 9): both
// `intake_exception` and `courier_status_exception` are PLATFORM-ONLY
// (permissive FORCE RLS, no program_id column), so these enter the ops read
// role bare, exactly like `listVendors` above. Neither table is granted to
// `fulfillment_read` (the tenant read role, tightened in
// 20260727000200_tighten_read_grants to the five tenant-facing tables only),
// so a read attempt under that role hits a Postgres permission-denied error,
// not an empty result (check 9 exclusion, asserted in ops-exceptions.test.ts).
//
// NO aggregate here (a later guard scans this file): a plain row-list SELECT
// only, `WHERE resolved_at IS NULL` unless the caller opts into resolved rows.
export interface IntakeExceptionView {
  id: string
  vndrId: string
  fileId: string
  rowRef: string
  reasonCode: string
  createdAt: Date
  resolvedAt: Date | null
  resolvedByActor: string | null
  /**
   * D-15 context: what this row collided with, when the reason code has an
   * answer for that. Null for every reason that carries none, which is most of
   * them. Today only `dispatch_already_has_device` writes it, as
   * `{ existingShptId, existingAwb }`. IDs and operational references only, no
   * serials (see the column comment in schema.prisma).
   */
  detail: unknown
}

interface IntakeExceptionDbRow {
  id: string
  vndr_id: string
  file_id: string
  row_ref: string
  reason_code: string
  created_at: Date
  resolved_at: Date | null
  resolved_by_actor: string | null
  detail: unknown
}

function toIntakeExceptionDto(r: IntakeExceptionDbRow): IntakeExceptionView {
  return {
    id: r.id,
    vndrId: fromUuid('vndr', r.vndr_id),
    fileId: r.file_id,
    rowRef: r.row_ref,
    reasonCode: r.reason_code,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedByActor: r.resolved_by_actor,
    detail: r.detail ?? null,
  }
}

export async function readIntakeExceptions(
  db: FulfillmentDb,
  { includeResolved }: { includeResolved: boolean },
): Promise<IntakeExceptionView[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    if (includeResolved) {
      return tx.$queryRaw<IntakeExceptionDbRow[]>`
        SELECT id::text AS id, vndr_id::text AS vndr_id, file_id, row_ref, reason_code, created_at,
               resolved_at, resolved_by_actor::text AS resolved_by_actor, detail
        FROM intake_exception
        ORDER BY created_at
      `
    }
    return tx.$queryRaw<IntakeExceptionDbRow[]>`
      SELECT id::text AS id, vndr_id::text AS vndr_id, file_id, row_ref, reason_code, created_at,
             resolved_at, resolved_by_actor::text AS resolved_by_actor, detail
      FROM intake_exception
      WHERE resolved_at IS NULL
      ORDER BY created_at
    `
  })
  return rows.map(toIntakeExceptionDto)
}

export interface CourierStatusExceptionView {
  id: string
  vndrId: string
  channel: string
  subjectRef: string
  fileId: string | null
  rowRef: string | null
  reasonCode: string
  createdAt: Date
  resolvedAt: Date | null
  resolvedByActor: string | null
  shptId: string | null
}

interface CourierStatusExceptionDbRow {
  id: string
  vndr_id: string
  channel: string
  subject_ref: string
  file_id: string | null
  row_ref: string | null
  reason_code: string
  created_at: Date
  resolved_at: Date | null
  resolved_by_actor: string | null
  shpt_id: string | null
}

function toCourierStatusExceptionDto(r: CourierStatusExceptionDbRow): CourierStatusExceptionView {
  return {
    id: r.id,
    vndrId: fromUuid('vndr', r.vndr_id),
    channel: r.channel,
    subjectRef: r.subject_ref,
    fileId: r.file_id,
    rowRef: r.row_ref,
    reasonCode: r.reason_code,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedByActor: r.resolved_by_actor,
    shptId: r.shpt_id !== null ? fromUuid('shpt', r.shpt_id) : null,
  }
}

// G-SHPT: the LEFT JOIN back to shpt on the exception's own subject_ref (the
// courier-reported AWB, an already-unique join key via shpt.awb @unique) lets
// an operator resolve a status exception without cross-referencing a separate
// shipment-list screen. LEFT (not INNER) is required: unknown_awb rows have
// no matching shpt row by construction (see G_SHPT_backend_spec.md section 1)
// and must still surface in the queue, with a null shptId, rather than
// disappearing. Both tables live in the fulfillment schema (intra-context,
// not a cross-context join, C4) and fulfillment_ops_read already has SELECT +
// a permissive USING(true) policy on both (see the T5b/T8 migrations), so no
// new grant/migration is needed.
export async function readCourierStatusExceptions(
  db: FulfillmentDb,
  { includeResolved }: { includeResolved: boolean },
): Promise<CourierStatusExceptionView[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    if (includeResolved) {
      return tx.$queryRaw<CourierStatusExceptionDbRow[]>`
        SELECT e.id::text AS id, e.vndr_id::text AS vndr_id, e.channel, e.subject_ref, e.file_id, e.row_ref,
               e.reason_code, e.created_at, e.resolved_at, e.resolved_by_actor::text AS resolved_by_actor,
               s.id::text AS shpt_id
        FROM courier_status_exception e
        LEFT JOIN shpt s ON s.awb = e.subject_ref
        ORDER BY e.created_at
      `
    }
    return tx.$queryRaw<CourierStatusExceptionDbRow[]>`
      SELECT e.id::text AS id, e.vndr_id::text AS vndr_id, e.channel, e.subject_ref, e.file_id, e.row_ref,
             e.reason_code, e.created_at, e.resolved_at, e.resolved_by_actor::text AS resolved_by_actor,
             s.id::text AS shpt_id
      FROM courier_status_exception e
      LEFT JOIN shpt s ON s.awb = e.subject_ref
      WHERE e.resolved_at IS NULL
      ORDER BY e.created_at
    `
  })
  return rows.map(toCourierStatusExceptionDto)
}

// Phase 3 Task 5b (BRD Annexure D.4): the bank/branch composition-config admin
// list, guard-only exactly like `vendors` above (no D2 authorize, no 6e; the
// read-only DB role scopes visibility -- see the T5b migration's GRANT SELECT
// on bank_composition_config to fulfillment_ops_read). No aggregate here (a
// later guard scans this file): a plain row-list SELECT only, optionally
// filtered to one tenant.
export interface BankCompositionConfigRow {
  id: string
  tenantId: string
  bankCode: string
  branchCode: string
  logoMasterRef: string | null
  logoDerivativeRef: string | null
  brandingParams: unknown
  imageTemplates: unknown
  createdAt: Date
  updatedAt: Date
}

interface BankCompositionConfigDbRow {
  id: string
  tenant_id: string
  bank_code: string
  branch_code: string
  logo_master_ref: string | null
  logo_derivative_ref: string | null
  branding_params: unknown
  image_templates: unknown
  created_at: Date
  updated_at: Date
}

function toBankCompositionConfigDto(r: BankCompositionConfigDbRow): BankCompositionConfigRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    bankCode: r.bank_code,
    branchCode: r.branch_code,
    logoMasterRef: r.logo_master_ref,
    logoDerivativeRef: r.logo_derivative_ref,
    brandingParams: r.branding_params,
    imageTemplates: r.image_templates,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function listBankCompositionConfigs(
  db: FulfillmentDb,
  opts: { tenantWire?: string } = {},
): Promise<BankCompositionConfigRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    if (opts.tenantWire !== undefined) {
      const tenantUuid = toUuid(opts.tenantWire)
      return tx.$queryRaw<BankCompositionConfigDbRow[]>`
        SELECT id::text AS id, tenant_id::text AS tenant_id, bank_code, branch_code,
               logo_master_ref, logo_derivative_ref, branding_params, image_templates, created_at, updated_at
        FROM bank_composition_config
        WHERE tenant_id = ${tenantUuid}::uuid
        ORDER BY bank_code, branch_code
      `
    }
    return tx.$queryRaw<BankCompositionConfigDbRow[]>`
      SELECT id::text AS id, tenant_id::text AS tenant_id, bank_code, branch_code,
             logo_master_ref, logo_derivative_ref, branding_params, image_templates, created_at, updated_at
      FROM bank_composition_config
      ORDER BY bank_code, branch_code
    `
  })
  return rows.map(toBankCompositionConfigDto)
}

// Phase 3 Task 6 (BRD 5.3.2): the batching-parameter admin list, guard-only
// exactly like the reads above (no D2 authorize, no 6e; the read-only DB role
// scopes visibility -- see the T6 migration's GRANT SELECT on batching_config
// to fulfillment_ops_read). No aggregate here (a later guard scans this file):
// a plain row-list SELECT only. The '' scope sentinels are mapped back to a
// discriminated scope + nullable wire ids for the admin UI.
export interface BatchingConfigRow {
  id: string
  scope: 'GLOBAL' | 'TENANT' | 'TENANT_PROGRAM' | 'BANK'
  tenantWire: string | null
  programWire: string | null
  /** R-7 (16 Aug 2026): set on a BANK-scope row, null on the pool tiers. */
  bankReferenceCode: string | null
  minLotSize: number
  /** Null on a BANK-scope row (a bank tier carries min lot only, R-7). */
  maxWaitSeconds: number | null
  createdAt: Date
  updatedAt: Date
}

interface BatchingConfigDbRow {
  id: string
  tenant_wire: string
  program_wire: string
  bank_reference_code: string
  min_lot_size: number
  max_wait_seconds: number | null
  created_at: Date
  updated_at: Date
}

function toBatchingConfigDto(r: BatchingConfigDbRow): BatchingConfigRow {
  const scope: BatchingConfigRow['scope'] =
    r.bank_reference_code !== ''
      ? 'BANK'
      : r.tenant_wire === ''
        ? 'GLOBAL'
        : r.program_wire === ''
          ? 'TENANT'
          : 'TENANT_PROGRAM'
  return {
    id: r.id,
    scope,
    tenantWire: r.tenant_wire === '' ? null : r.tenant_wire,
    programWire: r.program_wire === '' ? null : r.program_wire,
    bankReferenceCode: r.bank_reference_code === '' ? null : r.bank_reference_code,
    minLotSize: Number(r.min_lot_size),
    maxWaitSeconds: r.max_wait_seconds == null ? null : Number(r.max_wait_seconds),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function listBatchingConfigs(db: FulfillmentDb): Promise<BatchingConfigRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    return tx.$queryRaw<BatchingConfigDbRow[]>`
      SELECT id::text AS id, tenant_wire, program_wire, bank_reference_code, min_lot_size, max_wait_seconds, created_at, updated_at
      FROM batching_config
      ORDER BY tenant_wire, program_wire, bank_reference_code
    `
  })
  return rows.map(toBatchingConfigDto)
}

// ---------------------------------------------------------------------------
// P2-1: the four object-spine reads (batch list, batch detail, pool list,
// dispatch list). Before this, the ONLY batch-shaped ops read was
// download-by-typed-id, so the portal could fetch a batch's Excel but could not
// LIST batches to find one.
//
// All four follow the established posture above: guard-only at the edge (reads
// are not mutations, so no D2 authorize and no 6e), entering
// `fulfillment_ops_read` bare. batch / pending_pool_entry / shpt already carry
// that role's SELECT grant and a USING(true) ops policy from
// 20260727010000_ops_portal_columns_roles, so NO migration is needed here.
//
// NO aggregate in any of them: test/architecture.test.ts scans this file for
// SQL aggregate calls and its matcher reads COMMENTS too, so do not name them
// literally here. Batch size is read from the STORED batch.unit_count column
// that the batching PM already maintains, never recomputed in SQL.
//
// PII posture (D104 default-exclude): pending_pool_entry carries entitled
// recipient PII (ship_to_address, ship_to_contact_name, ship_to_mobile) and the
// raw qr/vpa values. The LIST projections below deliberately omit all of it: a
// worklist needs to identify a record, not to address a parcel. The ship-view
// remains available through the existing excel/:group download, which is the
// surface that documents that entitlement. shpt is PII-free by construction
// (AWB and carrier status only, see read.ts).

export interface BatchRow {
  id: string
  triggerReason: string
  unitCount: number
  printVndr: string | null
  triggeredByActor: string | null
  // BRD 5.3.4: the operator's reason for a MANUAL (force-dispatch) trigger.
  // Always null for LOT_SIZE and MAX_WAIT, which have no human behind them.
  //
  // Projected despite the D104 default-exclude posture noted above because it is
  // not recipient PII: it is an operator's own note about an operator's own
  // action, written by the operator who is now reading it back. Withholding it
  // would leave the reason recorded and unreadable, which audits nothing.
  triggerNote: string | null
  createdAt: Date
  updatedAt: Date
}

interface BatchDbRow {
  id: string
  trigger_reason: string
  unit_count: number
  print_vndr: string | null
  triggered_by_actor: string | null
  trigger_note: string | null
  created_at: Date
  updated_at: Date
}

function toBatchDto(r: BatchDbRow): BatchRow {
  return {
    id: fromUuid('btch', r.id),
    triggerReason: r.trigger_reason,
    unitCount: Number(r.unit_count),
    printVndr: r.print_vndr === null ? null : fromUuid('vndr', r.print_vndr),
    triggeredByActor: r.triggered_by_actor,
    triggerNote: r.trigger_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// Newest batch first: this is a worklist, and the batch an operator wants is
// almost always the one that just formed.
export async function listBatches(db: FulfillmentDb): Promise<BatchRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    return tx.$queryRaw<BatchDbRow[]>`
      SELECT id::text AS id, trigger_reason, unit_count, print_vndr::text AS print_vndr,
             triggered_by_actor::text AS triggered_by_actor, trigger_note, created_at, updated_at
      FROM batch
      ORDER BY created_at DESC
    `
  })
  return rows.map(toBatchDto)
}

// One line of a batch: enough to identify the record and see where it is, with
// no recipient PII (see the PII note above).
export interface BatchEntryRow {
  asgnId: string
  merchantDisplayName: string
  merchantLegalName: string
  bankReferenceCode: string
  bankDisplayName: string
  branchCode: string | null
  soundbox: boolean
  standeeCount: number
  stickerCount: number
  poolStatus: string
  dispatchState: string | null
  shipToSuperseded: boolean
  // Task 6 (2026-08-11 dispatch-group split): the pending_pool_entry column,
  // carried through so the portal can badge which delivery group a row
  // belongs to. NULL means a legacy, pre-split combined row (see
  // package.ts excelLinesFor for what that means for sheet membership).
  dispatchGroup: string | null
  // Stamped by projectReplacementToPool off the replacement_raised fact: a
  // damage case was opened on this dispatch and a replacement is on its way.
  // Read-side badge only; the case itself lives in tms (D-24).
  replacementRaised: boolean
}

interface BatchEntryDbRow {
  asgn_id: string
  merchant_display_name: string
  merchant_legal_name: string
  bank_reference_code: string
  bank_display_name: string
  branch_code: string | null
  soundbox: boolean
  standee_count: number
  sticker_count: number
  pool_status: string
  dispatch_state: string | null
  ship_to_superseded: boolean
  dispatch_group: string | null
  replacement_raised: boolean
}

function toBatchEntryDto(r: BatchEntryDbRow): BatchEntryRow {
  return {
    asgnId: fromUuid('asgn', r.asgn_id),
    merchantDisplayName: r.merchant_display_name,
    merchantLegalName: r.merchant_legal_name,
    bankReferenceCode: r.bank_reference_code,
    bankDisplayName: r.bank_display_name,
    branchCode: r.branch_code,
    soundbox: r.soundbox,
    standeeCount: Number(r.standee_count),
    stickerCount: Number(r.sticker_count),
    poolStatus: r.pool_status,
    dispatchState: r.dispatch_state,
    shipToSuperseded: r.ship_to_superseded,
    dispatchGroup: r.dispatch_group,
    replacementRaised: r.replacement_raised,
  }
}

export interface BatchArtifactRow {
  asgnId: string
  artifactType: string
  assetReference: string
  supersededAt: Date | null
  // The exact payload and merchant name the STORED artifact was composed with,
  // so the ops console's on-screen card proof cannot drift from what was
  // printed. Both are already-existing columns and the ops read role already
  // holds SELECT on them, so this is a projection widening only: no migration,
  // no new grant. Read-only either way, and no secret rides here (a UPI payload
  // and a display name are both already on the bank request the operator
  // uploaded).
  labelQr: string
  labelDisplayName: string
}

interface BatchArtifactDbRow {
  asgn_id: string
  artifact_type: string
  asset_reference: string
  superseded_at: Date | null
  label_qr: string
  label_display_name: string
}

export interface BatchDetailView {
  batch: BatchRow
  entries: BatchEntryRow[]
  artifacts: BatchArtifactRow[]
  // W-6 (Task 14, 2026-08-11 dispatch-group split): the BOUND print vendor's
  // press layout, ONE_PER_PAGE or GRID_3X2, resolved the same way
  // assembleGroupPdf resolves it at download time (package.ts): a LEFT JOIN
  // from batch to vndr on print_vndr, defaulting to ONE_PER_PAGE when the
  // batch has no bound vendor. Named here so the portal can tell an operator
  // which shape a download will actually be, without guessing from the
  // vendor id alone.
  printLayout: string
}

// The batch detail hub. Returns null for an unknown batch so the edge can 404
// rather than present an empty batch that looks real. Artifacts come back
// row-level (one per assignment per type) so the UI can offer exactly the
// download buttons that exist, instead of probing the download route and
// treating its 404 as "no artifact".
export async function readBatchDetail(db: FulfillmentDb, btchId: string): Promise<BatchDetailView | null> {
  const btchUuid = toUuid(btchId)
  return db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    // LEFT JOIN, not INNER: a batch with no bound print vendor (print_vndr
    // NULL) must still return its header, with the ONE_PER_PAGE default the
    // COALESCE below supplies, exactly as assembleGroupPdf's own fallback does.
    const header = await tx.$queryRaw<(BatchDbRow & { print_layout: string })[]>`
      SELECT b.id::text AS id, b.trigger_reason, b.unit_count, b.print_vndr::text AS print_vndr,
             b.triggered_by_actor::text AS triggered_by_actor, b.trigger_note, b.created_at, b.updated_at,
             COALESCE(v.print_layout, 'ONE_PER_PAGE') AS print_layout
      FROM batch b
      LEFT JOIN vndr v ON v.id = b.print_vndr
      WHERE b.id = ${btchUuid}::uuid
    `
    if (header.length === 0) return null
    const entries = await tx.$queryRaw<BatchEntryDbRow[]>`
      SELECT asgn_id::text AS asgn_id, merchant_display_name, merchant_legal_name,
             bank_reference_code, bank_display_name, branch_code, soundbox,
             standee_count, sticker_count, pool_status, dispatch_state, ship_to_superseded,
             dispatch_group, replacement_raised
      FROM pending_pool_entry WHERE batch = ${btchUuid}::uuid
      ORDER BY bank_reference_code, branch_code, merchant_display_name, dispatch_group, asgn_id
    `
    // BANK then BRANCH then assignment, the one ordering every dispatch asset
    // uses (the entries list above, the dispatch sheet, and the merged delivery
    // PDFs, which all sort on those same three columns). This list was the
    // residual gap: it ordered by artifact type first, so the same batch read
    // back in a different order here than it printed in, and an operator
    // checking a page against this list was comparing two different sequences.
    //
    // Extended (2026-08-11 dispatch-group split design, section 1.9) with
    // merchant_display_name then dispatch_group ahead of the asgn_id
    // tie-breaker: bank and branch stay the primary grouping, unchanged,
    // because they drive the printed picking sheet. A Task 5 split request
    // mints TWO rows, one SOUNDBOX and one COLLATERAL, that otherwise sort
    // apart under whatever asgn_id each happened to get. Sorting by merchant
    // then group puts a request's two dispatch groups adjacent in this list,
    // which is what the badge column exists to distinguish.
    //
    // The sort columns live on pending_pool_entry, hence the join, on the
    // already-unique pending_pool_entry.asgn_id. LEFT, not INNER: an artifact
    // whose entry is missing must still be listed rather than silently
    // disappearing from the batch, so the response shape is unchanged and only
    // the order moves. Both tables are in the fulfillment schema (intra-context,
    // not a cross-context join, C4), and this stays row-level: a join and an
    // ORDER BY, no aggregation (the guard scans this file).
    //
    // Superseded rows are deliberately KEPT here, unlike the delivery path in
    // package.ts: this read projects supersededAt precisely so an operator can
    // see that an artifact was recomposed.
    const artifacts = await tx.$queryRaw<BatchArtifactDbRow[]>`
      SELECT ca.asgn_id::text AS asgn_id, ca.artifact_type, ca.asset_reference, ca.superseded_at,
             ca.label_qr, ca.label_display_name
      FROM composed_artifact ca
      LEFT JOIN pending_pool_entry ppe ON ppe.asgn_id = ca.asgn_id
      WHERE ca.btch_id = ${btchUuid}::uuid
      ORDER BY ppe.bank_reference_code, ppe.branch_code, ca.asgn_id, ca.artifact_type
    `
    return {
      batch: toBatchDto(header[0]!),
      entries: entries.map(toBatchEntryDto),
      artifacts: artifacts.map((a) => ({
        asgnId: fromUuid('asgn', a.asgn_id),
        artifactType: a.artifact_type,
        assetReference: a.asset_reference,
        supersededAt: a.superseded_at,
        labelQr: a.label_qr,
        labelDisplayName: a.label_display_name,
      })),
      printLayout: header[0]!.print_layout,
    }
  })
}

// The pending pool: everything not yet batched, which is the queue an operator
// works. `poolStatus` narrows to one of POOLED / HELD / BATCHED; omitted returns
// the whole pool. Same PII-free projection as a batch entry, plus the batch it
// landed in (null while still pending) so one list serves both views.
export interface PoolEntryRow extends BatchEntryRow {
  batch: string | null
  createdAt: Date
  // The pool this entry belongs to, as WIRE ids. Batching is per (tenant,
  // program), so without these the ops portal cannot offer "trigger THIS pool"
  // and has to ask the operator to type a tnnt_ and a prg_ from memory, which
  // is exactly the friction the portal redesign removes.
  //
  // NOT a grouping by bank: D7 pools many aggregator bank codes beneath one
  // tenant, so bank is display context, not the batchable unit.
  //
  // Both columns already existed on pending_pool_entry and were simply never
  // projected. Additive, no migration, no new permission, and they are opaque
  // ids rather than PII, so the D104 default-exclude posture is unchanged.
  tenantId: string
  programId: string
  /**
   * WHY a HELD entry was held (12 Aug 2026). Null on every POOLED or BATCHED
   * row, and also null on a hold placed before the column existed or by the
   * event-driven consumer, which has no human behind it. Operator free text, so
   * it is shown to operators and never put on a fact or an audit record.
   */
  holdReason: string | null
}

interface PoolEntryDbRow extends BatchEntryDbRow {
  batch: string | null
  created_at: Date
  tenant_id: string
  program_id: string
  hold_reason: string | null
}

function toPoolEntryDto(r: PoolEntryDbRow): PoolEntryRow {
  return {
    ...toBatchEntryDto(r),
    batch: r.batch === null ? null : fromUuid('btch', r.batch),
    createdAt: r.created_at,
    tenantId: fromUuid('tnnt', r.tenant_id),
    programId: fromUuid('prog', r.program_id),
    holdReason: r.hold_reason,
  }
}

const POOL_ENTRY_COLUMNS = `asgn_id::text AS asgn_id, merchant_display_name, merchant_legal_name,
             bank_reference_code, bank_display_name, branch_code, soundbox,
             standee_count, sticker_count, pool_status, dispatch_state, ship_to_superseded,
             dispatch_group, replacement_raised,
             batch::text AS batch, created_at,
             tenant_id::text AS tenant_id, program_id::text AS program_id,
             hold_reason`

export async function listPoolEntries(
  db: FulfillmentDb,
  { poolStatus }: { poolStatus?: string } = {},
): Promise<PoolEntryRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    // Oldest first: the pool is a FIFO queue and the oldest entry is the one
    // ageing toward its max-wait trigger.
    if (poolStatus !== undefined) {
      return tx.$queryRawUnsafe<PoolEntryDbRow[]>(
        `SELECT ${POOL_ENTRY_COLUMNS} FROM pending_pool_entry WHERE pool_status = $1 ORDER BY created_at`,
        poolStatus,
      )
    }
    return tx.$queryRawUnsafe<PoolEntryDbRow[]>(
      `SELECT ${POOL_ENTRY_COLUMNS} FROM pending_pool_entry ORDER BY created_at`,
    )
  })
  return rows.map(toPoolEntryDto)
}

// The ops dispatch list: every shipment, unscoped by program (the class-3
// operator sees the whole platform, unlike read.ts's readShipments which is the
// program-scoped class-2 TENANT read). PII-free by construction.
//
// WHAT'S IN THE PARCEL, and why it is two booleans rather than two numbers.
// One dispatch id can travel under TWO AWBs: the soundbox kit under one, the
// standee under another. So this list now contains rows that carry no device at
// all, and before these flags a collateral-only shipment appeared as an
// ordinary row with nothing in it: same AWB column, same status, no way to tell
// it apart from a shipment whose devices had gone missing.
//
// EXISTS, never an aggregate. This module is covered by the no-aggregate guard
// in test/architecture.test.ts (the ops portal is a queue and detail surface,
// not a dashboard), and the guard scans the file's TEXT, comments included. That
// is not an obstacle worked around here, it is the right shape anyway: the
// question the operator asks of a list row is "does this parcel have devices in
// it", which is a yes or no. How MANY is a detail-view question.
export interface DispatchRow {
  id: string
  awb: string
  status: string
  courierPartner: string | null
  dispatchDate: Date
  statusAt: Date | null
  statusSource: string | null
  /** true when at least one unit travels on this shipment. */
  hasUnits: boolean
  /** true when at least one assignment's collateral travels on this shipment. */
  hasCollateral: boolean
  createdAt: Date
  updatedAt: Date
}

interface DispatchDbRow {
  id: string
  awb: string
  status: string
  courier_partner: string | null
  dispatch_date: Date
  status_at: Date | null
  status_source: string | null
  has_units: boolean
  has_collateral: boolean
  created_at: Date
  updated_at: Date
}

export async function listDispatches(db: FulfillmentDb, { status }: { status?: string } = {}): Promise<DispatchRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    if (status !== undefined) {
      return tx.$queryRaw<DispatchDbRow[]>`
        SELECT s.id::text AS id, s.awb, s.status, s.courier_partner::text AS courier_partner, s.dispatch_date,
               s.status_at, s.status_source, s.created_at, s.updated_at,
               EXISTS (SELECT 1 FROM unit u WHERE u.shipment = s.id) AS has_units,
               EXISTS (SELECT 1 FROM pending_pool_entry p WHERE p.collateral_shipment = s.id) AS has_collateral
        FROM shpt s WHERE s.status = ${status}
        ORDER BY s.dispatch_date DESC
      `
    }
    return tx.$queryRaw<DispatchDbRow[]>`
      SELECT s.id::text AS id, s.awb, s.status, s.courier_partner::text AS courier_partner, s.dispatch_date,
             s.status_at, s.status_source, s.created_at, s.updated_at,
             EXISTS (SELECT 1 FROM unit u WHERE u.shipment = s.id) AS has_units,
             EXISTS (SELECT 1 FROM pending_pool_entry p WHERE p.collateral_shipment = s.id) AS has_collateral
      FROM shpt s
      ORDER BY s.dispatch_date DESC
    `
  })
  return rows.map((r) => ({
    id: fromUuid('shpt', r.id),
    awb: r.awb,
    status: r.status,
    courierPartner: r.courier_partner === null ? null : fromUuid('vndr', r.courier_partner),
    dispatchDate: r.dispatch_date,
    statusAt: r.status_at,
    statusSource: r.status_source,
    hasUnits: r.has_units,
    hasCollateral: r.has_collateral,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

// The device inventory list.
//
// `unit` is the device lifecycle table, and until this read existed no ops
// surface could see it at all: an operator could not tell how many devices were
// in stock, could not look one up by serial, and could not tell which devices a
// batch had become. The data was correct the whole time and simply invisible.
//
// PLATFORM-ONLY, like vndr above, so this enters the ops read role bare with no
// program scope to set. Row-level only, no aggregate (the guard scans this
// file); a caller wanting "how many are in stock" filters by status and reads
// the length of what it gets back.
//
// The merchant a device was printed for is returned as a wire id and NOT joined
// to a name here: merchants live in TMS and C4 forbids the cross-context read.
// The portal already resolves that name from GET /ops/merchants, the same way
// batch detail resolves a vendor name.
//
// sim_no rides the LIST in full. Grant widened by migration 20260812150000
// under the 2026-08-12 product ruling; that ruling first shipped the SIM
// masked with a per-device Reveal, then was overturned the same day (this is
// an internal admin console, not a merchant-facing surface, so masking a
// value the operator needs to cross-check against the source Excel just cost
// them a click). The device_qr payload is still on-demand only
// (readDeviceDetail below): it is a raw manufacturer blob, not a value an
// operator verifies by eye the way a SIM number is. The ICCID still never
// rides a fact (S7) and is never logged.
export interface UnitInventoryRow {
  id: string
  deviceSerial: string | null
  status: string
  // D-16 (T4.4): the ACTIVATION axis, independent of `status` above. Null means
  // not activated; a value means the CWD activated it at that instant, whatever
  // the delivery axis happens to say. The two are returned side by side on
  // purpose, because collapsing them back into one column is the defect D-16
  // was written to fix.
  activatedAt: Date | null
  productType: string
  manufacturerVndr: string | null
  batch: string | null
  shipment: string | null
  printedForMerchant: string | null
  asgnId: string | null
  location: string | null
  simNo: string | null
  createdAt: Date
  updatedAt: Date
}

// The per-device detail: the list row PLUS the on-demand device_qr payload.
// Served one device at a time, never as a list.
export interface UnitDetailView extends UnitInventoryRow {
  deviceQr: unknown
}

interface UnitInventoryDbRow {
  id: string
  device_serial: string | null
  status: string
  activated_at: Date | null
  product_type: string
  manufacturer_vndr: string | null
  batch: string | null
  shipment: string | null
  printed_for_merchant: string | null
  asgn_id: string | null
  location: string | null
  sim_no: string | null
  created_at: Date
  updated_at: Date
}

function toUnitInventoryDto(r: UnitInventoryDbRow): UnitInventoryRow {
  return {
    id: fromUuid('unit', r.id),
    deviceSerial: r.device_serial,
    status: r.status,
    activatedAt: r.activated_at,
    productType: r.product_type,
    manufacturerVndr: r.manufacturer_vndr === null ? null : fromUuid('vndr', r.manufacturer_vndr),
    batch: r.batch === null ? null : fromUuid('btch', r.batch),
    shipment: r.shipment === null ? null : fromUuid('shpt', r.shipment),
    printedForMerchant: r.printed_for_merchant === null ? null : fromUuid('mrch', r.printed_for_merchant),
    asgnId: r.asgn_id === null ? null : fromUuid('asgn', r.asgn_id),
    location: r.location,
    simNo: r.sim_no,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function listDeviceInventory(
  db: FulfillmentDb,
  { status }: { status?: string } = {},
): Promise<UnitInventoryRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    if (status !== undefined) {
      return tx.$queryRaw<UnitInventoryDbRow[]>`
        SELECT id::text AS id, device_serial, status, activated_at, product_type,
               manufacturer_vndr::text AS manufacturer_vndr, batch::text AS batch,
               shipment::text AS shipment, printed_for_merchant::text AS printed_for_merchant,
               asgn_id::text AS asgn_id, location, sim_no, created_at, updated_at
        FROM unit WHERE status = ${status}
        ORDER BY device_serial
      `
    }
    return tx.$queryRaw<UnitInventoryDbRow[]>`
      SELECT id::text AS id, device_serial, status, activated_at, product_type,
               manufacturer_vndr::text AS manufacturer_vndr, batch::text AS batch,
               shipment::text AS shipment, printed_for_merchant::text AS printed_for_merchant,
               asgn_id::text AS asgn_id, location, sim_no, created_at, updated_at
      FROM unit
      ORDER BY device_serial
    `
  })
  return rows.map(toUnitInventoryDto)
}

// D-16 (T4.5): the DELIVERY branch's trail for one dispatch, cross-tenant, for
// the per-dispatch detail page. The tenant edge has had this read since spec
// 10b (read.ts's readShipmentStatusTrail); ops could not reach it, because that
// one enters the PROGRAM-SCOPED fulfillment_read role and an ops operator holds
// no program scope by construction (guardrail G1). This is the same query under
// fulfillment_ops_read, whose shpt_status_event policy is permissive by design.
//
// PLATFORM-ONLY entry (no program to bind), like every other read in this file.
// AWB and carrier status only, which is what the table carries: no recipient
// PII reaches this row.
export interface DispatchStatusEventRow {
  status: string
  courierTimestamp: Date
  statusSource: string
  sourceRef: string
  receivedAt: Date
  overrideReason: string | null
}

export async function readShipmentTrailOps(db: FulfillmentDb, shptId: string): Promise<DispatchStatusEventRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    return tx.$queryRaw<{
      status: string
      courier_timestamp: Date
      status_source: string
      source_ref: string
      received_at: Date
      override_reason: string | null
    }[]>`
      SELECT status, courier_timestamp, status_source, source_ref, received_at, override_reason
      FROM shpt_status_event
      WHERE shpt_id = ${toUuid(shptId)}::uuid
      ORDER BY courier_timestamp ASC, received_at ASC
    `
  })
  return rows.map((r) => ({
    status: r.status,
    courierTimestamp: r.courier_timestamp,
    statusSource: r.status_source,
    sourceRef: r.source_ref,
    receivedAt: r.received_at,
    overrideReason: r.override_reason,
  }))
}

// T5.5 (D-19): resolve DEVICE SERIALS back to the assignments they were printed
// for, so the ops activation upload can drive the TMS activation write.
//
// The CWD's file names devices, because that is what it activates and what its
// own systems track. The platform activates ASSIGNMENTS. `unit.asgn_id` is the
// link, and it exists precisely because a merchant can hold several assignments
// over time and printed_for_merchant cannot tell them apart.
//
// This returns a MAP rather than a list, and returns nothing for a serial it
// cannot place, so the caller can report which rows it could not resolve instead
// of quietly returning fewer rows than it was given. A device that exists but
// has never been paired is not in the map either: a null asgn_id means nobody
// has printed it for anyone, which is not something to guess about.
export async function resolveAssignmentsByDeviceSerial(
  db: FulfillmentDb,
  deviceSerials: string[],
): Promise<Map<string, string>> {
  if (deviceSerials.length === 0) return new Map()
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    return tx.$queryRaw<{ device_serial: string; asgn_id: string | null }[]>`
      SELECT device_serial, asgn_id::text AS asgn_id
      FROM unit
      WHERE device_serial = ANY(${deviceSerials}::text[]) AND asgn_id IS NOT NULL
    `
  })
  const out = new Map<string, string>()
  for (const r of rows) {
    if (r.device_serial !== null && r.asgn_id !== null) out.set(r.device_serial, fromUuid('asgn', r.asgn_id))
  }
  return out
}

// R-5 (16 Aug 2026, docs/plan/UAT_DECISIONS_2026-08-16.md): the ICCID for the
// activation report, keyed by device serial. The report itself is an analytics
// read; the SIM deliberately never reaches analytics (S7, migration
// 20260803120000), so the ops edge fans out HERE, under fulfillment_ops_read,
// whose column grant carries sim_no (20260812150000). Same posture as
// resolveAssignmentsByDeviceSerial above: guard-only read, no 6e of its own,
// the route's analytics 6e already records the access.
export async function readUnitSimsBySerialsOps(
  db: FulfillmentDb,
  deviceSerials: readonly string[],
): Promise<Map<string, string>> {
  if (deviceSerials.length === 0) return new Map()
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    return tx.$queryRaw<{ device_serial: string; sim_no: string | null }[]>`
      SELECT device_serial, sim_no
      FROM unit
      WHERE device_serial = ANY(${deviceSerials}::text[])
    `
  })
  const out = new Map<string, string>()
  for (const r of rows) {
    if (r.sim_no !== null && r.sim_no !== '') out.set(r.device_serial, r.sim_no)
  }
  return out
}

// One device, by wire unit id, with the on-demand device_qr payload. Null when
// the id decodes but no such unit exists; the edge maps that to a 404. An
// undecodable id is the caller's error and throws InvalidIdError for the edge
// to map to a 400.
export async function readDeviceDetail(db: FulfillmentDb, unitId: string): Promise<UnitDetailView | null> {
  const unitUuid = toUuid(unitId)
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    return tx.$queryRaw<(UnitInventoryDbRow & { device_qr: unknown })[]>`
      SELECT id::text AS id, device_serial, status, product_type,
             manufacturer_vndr::text AS manufacturer_vndr, batch::text AS batch,
             shipment::text AS shipment, printed_for_merchant::text AS printed_for_merchant,
             asgn_id::text AS asgn_id, location, sim_no, device_qr, created_at, updated_at
      FROM unit WHERE id = ${unitUuid}::uuid
    `
  })
  const r = rows[0]
  if (r === undefined) return null
  return { ...toUnitInventoryDto(r), deviceQr: r.device_qr }
}
