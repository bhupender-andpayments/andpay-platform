import type { ApiRequest } from './client.js'
import { getAccessToken } from './tokenStore.js'
import { ApiError } from './errors.js'
import { opsBase } from '../lib/env.js'

type Client = { request<T>(req: ApiRequest): Promise<T> }

// The real /session/login contract (apps/auth-edge/src/login.controller.ts):
// body is { handle, password, totp } and the response is ONLY { accessToken }.
// There is no principal object on the wire; the caller derives a display
// principal by decoding the token itself (see AuthContext.decodeTokenClaims).
// `enrollmentRequired` is returned when the principal authenticated by password
// but holds no TOTP enrollment yet. The accessToken is then an enrollment-only
// token (one permission, short TTL, no refresh cookie was set), good only for
// POST /enroll against the caller's own principal.
export function login(c: Client, body: { handle: string; password: string; totp: string }) {
  // An EMPTY totp is omitted from the wire rather than sent as "". The edge
  // treats a present totp as an attempt to verify it, so sending "" would be a
  // guaranteed mfa-failed DENY; omitting it is the deliberate password-only
  // request the first-login enrollment path answers.
  const { totp, ...rest } = body
  return c.request<{ accessToken?: string; enrollmentRequired?: boolean; mfaRequired?: boolean }>({
    method: 'POST',
    path: '/session/login',
    base: 'auth',
    withCookie: true,
    body: totp === '' ? rest : body,
  })
}

// POST /enroll (apps/auth-edge/src/enroll.controller.ts). On the self-enrollment
// path the target MUST be the caller's own principal id; the edge rejects any
// other target. Returns the otpauth:// provisioning URI ONCE, so the QR is
// rendered from this response and never refetched.
export function enrollSelf(c: Client, body: { targetPrincipalId: string; targetAccountLabel: string }) {
  return c.request<{ otpauthUri: string }>({
    method: 'POST',
    path: '/enroll',
    base: 'auth',
    body,
  })
}

// POST /enroll/confirm. The enrollment stays PENDING (no factor on the account)
// until this succeeds, so abandoning the setup screen leaves the operator
// exactly as they were rather than locked out against a secret they never
// scanned.
export function confirmEnrollment(c: Client, body: { totp: string }) {
  return c.request<{ confirmed: true }>({
    method: 'POST',
    path: '/enroll/confirm',
    base: 'auth',
    body,
  })
}

// /session/logout (apps/auth-edge/src/session.controller.ts) is a 204 with no
// body; it revokes the refresh-token family and clears the refresh cookie.
export function logout(c: Client) {
  return c.request<void>({ method: 'POST', path: '/session/logout', base: 'auth', withCookie: true })
}

// -----------------------------------------------------------------------
// Reports and dashboards (Task 10). The real ops-edge reports contract
// (apps/ops-edge/src/reports.controller.ts, grounded against
// services/analytics/src/mediation.ts's readTiles/readReport/readTileDrilldown
// return types):
//   GET /ops/reports/tiles              -> { tiles: TileSet, watermark }
//   GET /ops/reports/tiles/:tile        -> { rows: ReportRow[], watermark }
//   GET /ops/reports/:name              -> { rows: ReportRow[], watermark }
// Both drilldown and report support ?format=csv, which returns text/csv
// instead of the JSON shape above. D100: the freshness watermark rides the
// JSON body's `watermark.asOf` field on every read that returns one; the
// plain tiles route carries no header (and never needs one, since its own
// body already carries `watermark`). The client cannot read response headers
// today regardless (ApiResult.headers is never surfaced past sendOnce to a
// caller of `request`), so the body is the only place any caller can read it
// from.
// -----------------------------------------------------------------------

/**
 * Presentation-only filters (apps/ops-edge/src/reports.controller.ts's
 * toFilters): a date window plus an optional bank or courier-status
 * narrowing. Carries no program/scope field; the edge derives scope solely
 * from the verified claim (D99), never from a query param.
 */
export interface ReportFilters {
  from?: string
  to?: string
  bank?: string
  status?: string
}

/** The FR-09 dashboard tiles (services/analytics/src/mediation.ts TileSet). */
export interface TileSet {
  requestsReceived: number
  /** Design D8: total batches to date. Every other tile counts RECORDS. */
  totalBatches: number
  pendingQrAwaitingBatch: { count: number; oldestAgeDays: number | null }
  pendingPrintVendorPickup: number
  dispatchedNotDelivered: number
  deliveredNotActivated: number
  damagedReplacementOpen: number
  activatedSuccessfully: number
}

export type TileName = keyof TileSet

/** The six FR-10 reports (services/analytics/src/mediation.ts ReportName). */
export type ReportName =
  // Every dispatch leg from the moment it is minted (D12, 18 Aug 2026). The
  // Dispatches page reads this; soundbox-delivery stays for the Command Center,
  // which genuinely wants the delivery-only view.
  | 'dispatches'
  | 'soundbox-delivery'
  | 'activation'
  | 'damaged-replacement'
  | 'print-vendor-pendency'
  | 'courier-pendency'
  | 'batching'

export type ReportCell = string | number | boolean | string[] | null
export type ReportRow = Record<string, ReportCell>

/** services/analytics/src/watermark.ts Watermark, carried on every mediated read. */
export interface Watermark {
  asOf: string | null
  perTopic: Record<string, string>
}

function buildQuery(params: ReportFilters & { format?: string }): string {
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) usp.set(key, value)
  }
  const qs = usp.toString()
  return qs === '' ? '' : `?${qs}`
}

export function getTiles(c: Client, filters: ReportFilters = {}) {
  return c.request<{ tiles: TileSet; watermark: Watermark }>({
    method: 'GET',
    path: `/ops/reports/tiles${buildQuery(filters)}`,
  })
}

export function getTileDrilldown(c: Client, tile: TileName, filters: ReportFilters = {}) {
  return c.request<{ rows: ReportRow[]; watermark: Watermark }>({
    method: 'GET',
    path: `/ops/reports/tiles/${tile}${buildQuery(filters)}`,
  })
}

// CSV export of a tile's drilldown: the same route with ?format=csv, read as
// raw text (Task 10's client extension) since a CSV body is not valid JSON.
export function getTileDrilldownCsv(c: Client, tile: TileName, filters: ReportFilters = {}) {
  return c.request<string>({
    method: 'GET',
    path: `/ops/reports/tiles/${tile}${buildQuery({ ...filters, format: 'csv' })}`,
    responseType: 'text',
  })
}

export function getReport(c: Client, name: ReportName, filters: ReportFilters = {}) {
  return c.request<{ rows: ReportRow[]; watermark: Watermark }>({
    method: 'GET',
    path: `/ops/reports/${name}${buildQuery(filters)}`,
  })
}

// CSV export of a report: same route with ?format=csv, read as raw text.
export function getReportCsv(c: Client, name: ReportName, filters: ReportFilters = {}) {
  return c.request<string>({
    method: 'GET',
    path: `/ops/reports/${name}${buildQuery({ ...filters, format: 'csv' })}`,
    responseType: 'text',
  })
}

/**
 * The wire `shpt_` id a `soundbox-delivery` report row may carry (G-SHPT,
 * services/analytics/src/mediation.ts's soundboxDeliveryRow, commit
 * 354aa76): `shptId: r.shpt_id` copied verbatim off `dispatch_row`, already
 * wire end to end (no `fromUuid` needed there per the grounding trace in
 * docs/plan/phase7_grounding/G_SHPT_backend_spec.md section 2b). `null`
 * until a shipment fact has folded for that dispatch (a real, faithful
 * null, not an error). `ReportRow` is a generic `Record<string, ReportCell>`
 * (every report has its own column set), so this is a typed narrow-read
 * helper rather than a new named DTO field, matching the existing dynamic
 * report-row convention (ReportPage/DispatchHistoryPage's buildColumns).
 */
export function reportRowShptId(row: ReportRow): string | null {
  const value = row.shptId
  return typeof value === 'string' ? value : null
}

// -----------------------------------------------------------------------
// Exception and quarantine queues (Task 11). The confirmed ops-edge contract
// (apps/ops-edge/src/ops-read.controller.ts for the three reads,
// apps/ops-edge/src/ops.controller.ts for the three resolves): a class-3
// guard-only read (no per-op authorize, check 3) and a gated write (the
// shared `gate()` template: Idempotency-Key required, D2 authorize; NONE of
// the three resolves are in OPS_STEP_UP_GATED_OPERATIONS, so no step-up key
// is passed here). `?includeResolved=true` opts a queue into its resolved
// rows; the default query omits the param entirely (the read side treats a
// missing param as `false`, apps/ops-edge/src/ops-read.controller.ts).
// -----------------------------------------------------------------------

/** services/tms/src/ops-read.ts QuarantineRowView. */
export interface QuarantineRowView {
  id: string
  fileId: string
  rowNo: number
  reasonCode: string
  /**
   * Per-reason structured evidence (ruling 2026-08-10). Null for every reason
   * but `duplicate_vpa_soundbox`, which carries `duplicateOf` so the queue can
   * name the original the row collides with. See
   * services/tms/src/ops-read.ts QuarantineRowDetail. `DuplicateVpaOriginal` is
   * declared in the uploads section further down this file.
   */
  detail: { duplicateOf?: DuplicateVpaOriginal } | null
  createdAt: string
  resolvedAt: string | null
  resolvedByActor: string | null
  /**
   * WHICH of D-8's two actions retired the row: 'cured' (an ingest was
   * re-driven with a corrected row) or 'closed' (archived as a genuine
   * duplicate). Null while the row is open, and also null on rows resolved
   * before the distinction existed. Optional so an older server that predates
   * the column still parses.
   */
  resolution?: 'cured' | 'closed' | null
}

/** services/fulfillment/src/ops-read.ts IntakeExceptionView. */
export interface IntakeExceptionView {
  id: string
  vndrId: string
  fileId: string
  rowRef: string
  reasonCode: string
  createdAt: string
  resolvedAt: string | null
  resolvedByActor: string | null
  /**
   * D-15 context: what this row collided with. Null for every reason code that
   * has no answer for that, which is most of them. Today only
   * `dispatch_already_has_device` writes it. Typed as the one shape that exists
   * rather than `unknown`, so the screen can render it without a cast, and
   * OPTIONAL so an older server that predates the column still parses.
   */
  detail?: { existingShptId: string | null; existingAwb: string | null } | null
}

// services/fulfillment/src/ops-read.ts CourierStatusExceptionView: fileId and
// rowRef are nullable on the wire (a status exception is not always tied to a
// specific ingest file/row), unlike the brief's flattened summary. G-SHPT
// (commit 354aa76): shptId is a LEFT JOIN against shpt.awb = subjectRef, so it
// is null for reason codes with no matching shipment (unknown_awb, and a
// webhook-channel unknown_status whose AWB was never looked up) and a real
// wire `shpt_` id otherwise (courier_unassigned, wrong_courier, file-channel
// unknown_status). Only a non-null shptId is safe to send to
// resolveStatusException below.
export interface CourierStatusExceptionView {
  id: string
  vndrId: string
  channel: string
  subjectRef: string
  fileId: string | null
  rowRef: string | null
  reasonCode: string
  createdAt: string
  resolvedAt: string | null
  resolvedByActor: string | null
  shptId: string | null
}

// services/tms/src/ingest.ts BankRequestRow: the full field list, including
// the spec 06a mandatory recipient contact columns (contactName, mobile), the
// Phase 3 Task 4 mandatory branchCode (BRD 5.1b; requestRowRejectReason now
// rejects an empty branchCode as 'missing_branch_code', fail-closed at
// ingest), and the optional vpaHint the brief's flattened list omitted.
export interface BankRequestRow {
  fileId: string
  rowNo: number
  bankMerchantReference: string
  displayName: string
  legalName: string
  mcc: string
  registeredAddress: string
  bankReferenceCode: string
  productType: string
  vpaValue: string
  qrValue: string
  soundbox: boolean
  standeeCount: number
  stickerCount: number
  shipToAddress: string
  contactName: string
  mobile: string
  branchCode: string
  vpaHint?: string
}

// services/fulfillment/src/intake.ts IntakeRow (discriminated union) and
// IntakeSheet.
export interface SerializedIntakeRow {
  kind: 'SERIALIZED'
  deviceSerial: string
  productType: string
  deviceQr: object
}
export interface QuantityLineIntakeRow {
  kind: 'QUANTITY_LINE'
  productType: string
  count: number
  qrString: string
}
export type IntakeRow = SerializedIntakeRow | QuantityLineIntakeRow

export interface IntakeSheet {
  fileId: string
  vndrId: string
  workQueue: string
  rows: IntakeRow[]
}

function includeResolvedQuery(includeResolved: boolean): string {
  return includeResolved ? '?includeResolved=true' : ''
}

export function getQuarantine(c: Client, includeResolved = false) {
  return c.request<QuarantineRowView[]>({
    method: 'GET',
    path: `/ops/quarantine${includeResolvedQuery(includeResolved)}`,
  })
}

export function getIntakeExceptions(c: Client, includeResolved = false) {
  return c.request<IntakeExceptionView[]>({
    method: 'GET',
    path: `/ops/exceptions/intake${includeResolvedQuery(includeResolved)}`,
  })
}

export function getStatusExceptions(c: Client, includeResolved = false) {
  return c.request<CourierStatusExceptionView[]>({
    method: 'GET',
    path: `/ops/exceptions/status${includeResolvedQuery(includeResolved)}`,
  })
}

/**
 * `cured: false` on a call that RAN (deduped false) is a refused correction:
 * the corrected row did not ingest, so the hold stays in the queue rather than
 * being retired (services/tms/src/ops.ts resolveQuarantineRow). It is the same
 * shape as the close route's `closed`, and callers must read it for the same
 * reason: a 200 here means the operation was authorized and ran, not that the
 * row was cured.
 */
export function resolveQuarantine(c: Client, id: string, correctedRow: BankRequestRow, idempotencyKey: string) {
  return c.request<{ deduped: boolean; outcome: string | null; cured: boolean }>({
    method: 'POST',
    path: `/ops/quarantine/${id}/resolve`,
    body: { correctedRow },
    idempotencyKey,
  })
}

// D-8's other action: archive the held row with no ingest. No body, because
// closing is a decision about the record as it stands, not a correction to it.
export function closeQuarantine(c: Client, id: string, idempotencyKey: string) {
  return c.request<{ deduped: boolean; closed: boolean }>({
    method: 'POST',
    path: `/ops/quarantine/${id}/close`,
    body: {},
    idempotencyKey,
  })
}

export function resolveIntakeException(c: Client, id: string, correctedSheet: IntakeSheet, idempotencyKey: string) {
  return c.request<{ deduped: boolean; result: unknown }>({
    method: 'POST',
    path: `/ops/intake-exceptions/${id}/resolve`,
    body: { correctedSheet },
    idempotencyKey,
  })
}

// G-SHPT (docs/plan/phase7_grounding/B_edge_contracts.md gap 2, resolved by
// commit 354aa76 / docs/plan/phase7_grounding/G_SHPT_backend_spec.md): body.shptId
// must be a WIRE shpt id (the domain op `toUuid`s it). GET /ops/exceptions/status
// now LEFT JOINs to shpt.awb = subjectRef and exposes that as
// CourierStatusExceptionView.shptId (string | null). QueuesPage.tsx sources
// body.shptId ONLY from a row's own non-null shptId (never subjectRef, never
// the raw exception id, never hand-typed): rows with a null shptId
// (unknown_awb, and any webhook-channel unknown_status whose AWB was never
// looked up) have no matching shipment to correct and stay permanently gated.
export interface StatusExceptionResolveBody {
  shptId: string
  status: string
  courierTimestamp: string
}

export function resolveStatusException(
  c: Client,
  id: string,
  body: StatusExceptionResolveBody,
  idempotencyKey: string,
) {
  return c.request<{ deduped: boolean; outcome: string | null }>({
    method: 'POST',
    path: `/ops/status-exceptions/${id}/resolve`,
    body,
    idempotencyKey,
  })
}

// -----------------------------------------------------------------------
// Master data: vendor registry and courier master (Task 12). The confirmed
// ops-edge contract (apps/ops-edge/src/ops-read.controller.ts's `vendors()`,
// grounded against services/fulfillment/src/ops-read.ts's listVendors /
// VendorRow): a class-3 guard-only read (no per-op authorize, check 3),
// platform-only (no program scope) list of ALL vendors regardless of type.
// The courier master is NOT a separate route: CourierMasterPage renders this
// same list filtered client-side to type === 'COURIER'. Read-only here;
// vendor create and suspend are Tasks 14/15.
// -----------------------------------------------------------------------

/**
 * services/fulfillment/src/ops-read.ts VendorRow. `type` is one of
 * MANUFACTURER | PRINT | COURIER. `createdAt`/`updatedAt` are typed `Date` on
 * the server but arrive as JSON strings over the wire (JSON has no Date
 * type), so the SPA DTO types them as `string`, matching every other wire
 * timestamp in this file (e.g. QuarantineRowView.createdAt).
 */
export interface VendorRow {
  id: string
  type: string
  displayName: string
  status: string
  courierCode: string | null
  createdAt: string
  updatedAt: string
}

export function getVendors(c: Client) {
  return c.request<VendorRow[]>({ method: 'GET', path: '/ops/vendors' })
}

// -----------------------------------------------------------------------
// P2-1 object spine (apps/ops-edge/src/ops-read.controller.ts batches / pool /
// dispatches / batchDetail, over services/fulfillment/src/ops-read.ts). Same
// class-3 guard-only posture as GET /ops/vendors above: no per-op D2
// authorize, no 6e, reads are not mutations (check 3).
//
// These projections are deliberately PII-FREE on the server (D104
// default-exclude): no ship-to address, contact name, mobile, or raw qr/vpa
// value is returned, so none of it can be rendered here. The ship-view lives
// in the excel/:group download, which is the surface that documents that
// entitlement. Do NOT "enrich" these rows client-side from another endpoint.
// -----------------------------------------------------------------------

/** services/fulfillment/src/ops-read.ts BatchRow. */
export interface BatchRow {
  id: string
  /**
   * The batch lifecycle: BATCHED, SENT_TO_PRINT_VENDOR, CLOSED.
   *
   * This field was once declared here with no read behind it, which made
   * RecentBatches render an empty pill, and the standing instruction was not to
   * add a status without a read that can answer it. As of 18 Aug 2026 there is
   * one: batch.status is stored again, written by exactly three named writers
   * (the batching trigger, the ops send-to-vendor action, the ops close
   * action), and ops-read.ts BatchRow projects it. Mirrors BATCH_STATUSES in
   * services/fulfillment/src/batch-status.ts.
   */
  status: string
  triggerReason: string
  unitCount: number
  printVndr: string | null
  triggeredByActor: string | null
  // BRD 5.3.4: the operator's reason for a MANUAL trigger, null for LOT_SIZE
  // and MAX_WAIT (nothing human fired those).
  triggerNote: string | null
  createdAt: string
  updatedAt: string
}

/** services/fulfillment/src/ops-read.ts BatchEntryRow (PII-free). */
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
  // 19 Aug 2026: the courier's own axis. dispatchState never reaches
  // DELIVERED (it stops at DISPATCHED_BY_VENDOR by design); this is what
  // moves past that once a shipment exists and the courier (or an ops
  // correction, e.g. "Mark all delivered") advances it. Null until a
  // shipment exists for the leg.
  courierStatus?: string | null
  shipToSuperseded: boolean
  // Task 6 (2026-08-11 dispatch-group split): NULL is a legacy, pre-split
  // combined row; 'SOUNDBOX' / 'COLLATERAL' otherwise. See
  // services/fulfillment/src/package.ts excelLinesFor for what this decides.
  dispatchGroup: string | null
  /**
   * The merchant REQUEST this dispatch came from ({file_id}|{row_no}). Both
   * dispatch groups minted from one bank row share it, so it is what groups a
   * soundbox and its collateral back into the one request an operator made.
   * The server's minimum-lot gate counts DISTINCT source_event_id, so counting
   * requests here is counting the same unit the server decides on.
   *
   * Optional so an older server that predates the projection still parses.
   */
  sourceEventId?: string
}

/** services/fulfillment/src/ops-read.ts PoolEntryRow. */
export interface PoolEntryRow extends BatchEntryRow {
  batch: string | null
  createdAt: string
  // The pool this entry belongs to. Batching is per (tenant, program), so these
  // are what let the pending-pool screen offer "trigger THIS pool" instead of
  // asking the operator to type a tnnt_ and a prg_ from memory.
  tenantId: string
  programId: string
  /**
   * WHY a HELD entry was held (12 Aug 2026). Null on POOLED and BATCHED rows,
   * and on a hold placed before the reason existed. Optional so an older server
   * that predates the column still parses.
   */
  holdReason?: string | null
}

/** services/fulfillment/src/ops-read.ts BatchArtifactRow. */
export interface BatchArtifactRow {
  asgnId: string
  artifactType: string
  assetReference: string
  supersededAt: string | null
  // What the STORED artifact was composed with. The collateral page renders its
  // card proof and its print PDFs from these, so the screen and the press run
  // agree with the artifact rather than with a second lookup that could drift.
  labelQr: string
  labelDisplayName: string
}

/**
 * services/fulfillment/src/ops-read.ts BatchSettlement: how far a batch's
 * dispatches have finished travelling, and therefore whether it can be closed.
 * A dispatch settles at DELIVERED, RETURNED, or its device DAMAGED.
 */
export interface BatchSettlement {
  total: number
  delivered: number
  returned: number
  pending: number
  settled: boolean
  /**
   * The same verdict per dispatch, keyed by wire asgn id, so the batch's own
   * dispatch table can mark which rows are holding the batch open instead of
   * making an operator subtract one count from another. Optional so an older
   * server that predates the projection still parses.
   */
  perDispatch?: Record<string, 'DELIVERED' | 'RETURNED' | 'PENDING'>
}

/** services/fulfillment/src/ops-read.ts BatchDetailView. */
export interface BatchDetailView {
  batch: BatchRow
  entries: BatchEntryRow[]
  artifacts: BatchArtifactRow[]
  // W-6 (Task 14): the BOUND print vendor's press layout, ONE_PER_PAGE or
  // GRID_3X2, defaulting to ONE_PER_PAGE when the batch has no bound vendor.
  printLayout: string
  /**
   * Whether this batch can be closed, and what it is still waiting for (D5).
   * Optional so an older server that predates the read still parses.
   */
  settlement?: BatchSettlement
}

/** services/fulfillment/src/ops-read.ts DispatchRow (PII-free by construction). */
export interface DispatchRow {
  id: string
  awb: string
  status: string
  courierPartner: string | null
  dispatchDate: string
  statusAt: string | null
  statusSource: string | null
  // What is IN the parcel. One dispatch id can travel under two AWBs (soundbox
  // kit under one, standee under another), so this list contains rows carrying
  // no device at all, and a collateral-only shipment would otherwise be
  // indistinguishable from one whose devices had gone missing. Booleans rather
  // than counts because the ops read is row-level only, never an aggregate.
  hasUnits: boolean
  hasCollateral: boolean
  createdAt: string
  updatedAt: string
}

export function getBatches(c: Client) {
  return c.request<BatchRow[]>({ method: 'GET', path: '/ops/batches' })
}

/**
 * services/tms/src/ops-read.ts MerchantRow (PII-free: the projection holds no
 * address, contact name or mobile at all).
 */
export interface MerchantRow {
  mrchId: string
  displayName: string
  legalName: string
  mcc: string
  status: string
  updatedAt: string
  // D-2: this merchant has more than one soundbox request, so at least one was
  // an ADDITIONAL request rather than a first order. DERIVED on read from the
  // requests themselves, never stored, so it cannot drift from them.
  hasAdditionalRequests: boolean
}

// Redesign step 7 (ruling 1b). Every merchant, not only those with something in
// flight: a search that silently omits settled merchants is why deriving this
// from the pool (option 1c) was rejected.
export function getMerchants(c: Client) {
  return c.request<MerchantRow[]>({ method: 'GET', path: '/ops/merchants' })
}

/**
 * Add a merchant by hand (2026-08-14, backend landed 2026-08-17): for the
 * merchant no bank file has carried yet. The normal door stays the bank request
 * upload, which creates merchants on its own.
 *
 * THE ROUTE NOW EXISTS (apps/ops-edge/src/ops.controller.ts createMerchantRoute,
 * over identity's createMerchant). Grounded against that signature, not
 * invented: an Idempotency-Key, and a 200 carrying `deduped` plus the new row's
 * wire mrchId, which is null on a client-key replay.
 */
// The BRD's own merchant record (section 5.1, the bank-file field table),
// minus the fields that belong to a REQUEST rather than a merchant (branch, QR
// string, kit quantities). Mandatory flags follow the BRD.
export interface MerchantCreateBody {
  /**
   * The Bank Master (GET /ops/bank-masters) sponsoring this merchant. Added
   * 2026-08-17: it is half of the (tenant, bank_merchant_reference) resolver
   * key the server writes, which is what makes the bank file that arrives for
   * this merchant later resolve to THIS merchant instead of minting a second
   * one. The mode and the principal still come from the token, never here
   * (M7/S16); the bank is a business choice the operator makes, not identity
   * context.
   */
  tnntWire: string
  displayName: string
  legalName: string
  mcc: string
  /**
   * The UPI ID. The server derives the merchant reference from it
   * (@andpay/merchant-ref, D1) and stores it as the resolver's vpa hint; it is
   * never a merchant column. Uniqueness is PER BANK, at the resolver's
   * UNIQUE(tenant_id, bank_merchant_reference): the same VPA under a different
   * bank is a different merchant. Deliberately not framed as a global "one
   * merchant per VPA" (TASKLIST C-1: D1 is an interim key with a re-key
   * expected, and the UI must not deepen it).
   */
  vpa: string
  contactName: string
  mobile: string
  email?: string
  address: string
  address2?: string
  address3?: string
  city: string
  state: string
  pincode: string
}

export function createMerchant(c: Client, body: MerchantCreateBody, idempotencyKey: string) {
  return c.request<{ deduped: boolean; mrchId: string | null }>({
    method: 'POST',
    path: '/ops/merchants',
    body,
    idempotencyKey,
  })
}

// 404 when the batch does not exist; the edge throws NotFoundException rather
// than returning an empty-but-valid-looking detail, so the caller can tell
// "no such batch" from "a batch with no entries".
export function getBatchDetail(c: Client, btchId: string) {
  return c.request<BatchDetailView>({ method: 'GET', path: `/ops/batches/${encodeURIComponent(btchId)}` })
}

export function getPoolEntries(c: Client, poolStatus?: string) {
  const q = poolStatus !== undefined && poolStatus !== '' ? `?poolStatus=${encodeURIComponent(poolStatus)}` : ''
  return c.request<PoolEntryRow[]>({ method: 'GET', path: `/ops/pool${q}` })
}

export interface UnitInventoryRow {
  id: string
  deviceSerial: string | null
  status: string
  // D-16: the activation axis, separate from `status`. Null means not
  // activated. A device can carry a value here while status still reads
  // DISPATCHED, which is the point of the split.
  activatedAt: string | null
  productType: string
  manufacturerVndr: string | null
  batch: string | null
  shipment: string | null
  printedForMerchant: string | null
  asgnId: string | null
  location: string | null
  // Full value, unmasked: an internal admin console, and the operator's whole
  // reason for looking is to cross-check it against the source Excel
  // (2026-08-13 ruling, reversing this same day's earlier masked-with-Reveal
  // decision).
  simNo: string | null
  createdAt: string
  updatedAt: string
}

// The device inventory list. The manufacturer QR payload is absent from THIS
// wire by design; see getDeviceDetail.
export function getDevices(c: Client, status?: string) {
  const q = status !== undefined && status !== '' ? `?status=${encodeURIComponent(status)}` : ''
  return c.request<UnitInventoryRow[]>({ method: 'GET', path: `/ops/devices${q}` })
}

// The on-demand per-device read: the list row plus the raw manufacturer QR
// payload. 404 when the device does not exist.
export interface UnitDetailRow extends UnitInventoryRow {
  deviceQr: unknown
}

export function getDeviceDetail(c: Client, unitId: string) {
  return c.request<UnitDetailRow>({ method: 'GET', path: `/ops/devices/${encodeURIComponent(unitId)}` })
}

// Manual unit-status correction (2026-08-13 ruling): the device page's edit
// control. Forward-only, same rule as everywhere else; the edge/domain reject
// an illegal move rather than trusting the picker's own option list.
//
// THE INSTANT IS THE SERVER'S (2026-08-17 ruling): no operator-supplied
// occurredAt. An earlier version sent one, but the edge's UnitStatusBody has
// no such field and never read it, so the input asked for a value that was
// silently discarded. `unit` carries status plus updated_at and the server
// stamps the move itself.
export function correctUnitStatus(c: Client, unitId: string, status: string, idempotencyKey: string) {
  return c.request<{ deduped: boolean; advanced: boolean }>({
    method: 'POST',
    path: `/ops/units/${encodeURIComponent(unitId)}/status`,
    body: { status },
    idempotencyKey,
  })
}

/**
 * Correct a device's OWN master data (2026-08-14): what the manufacturer's
 * intake file got wrong. A PARTIAL patch - omit a key to leave that field
 * alone, send null to clear it.
 *
 * Deliberately cannot reach status (that is correctUnitStatus above, which
 * carries the forward-only guard) or any pipeline field (batch, shipment,
 * merchant, dispatch), which are owned by the flows that set them.
 *
 * THE EDGE ROUTE IS NOT BUILT YET, by decision (2026-08-14): the backend team
 * owns POST /ops/units/:id/edit and is adding it separately. The portal side
 * ships first so the screen is real, and the contract this file states IS the
 * request for it: a partial body of the four fields below, an Idempotency-Key,
 * a 200 of { deduped }, device_serial uniqueness enforced server-side (a
 * collision answers 4xx, never a 500), and no pipeline field reachable at all.
 * Until it lands, the Device card's pencil saves and reports the edge's 404
 * inline, which is the honest failure and not a silent one.
 */
export interface UnitDetailsPatch {
  deviceSerial?: string
  simNo?: string | null
  manufacturerVndr?: string
  location?: string | null
}

export function editUnitDetails(c: Client, unitId: string, patch: UnitDetailsPatch, idempotencyKey: string) {
  return c.request<{ deduped: boolean }>({
    method: 'POST',
    path: `/ops/units/${encodeURIComponent(unitId)}/edit`,
    body: patch,
    idempotencyKey,
  })
}

export function getDispatches(c: Client, status?: string) {
  const q = status !== undefined && status !== '' ? `?status=${encodeURIComponent(status)}` : ''
  return c.request<DispatchRow[]>({ method: 'GET', path: `/ops/dispatches${q}` })
}

// services/tms/src/ops-read.ts DamageCaseView, via GET /ops/damage-cases.
// The inventory page joins replacement asgn ids against unit.asgnId to mark
// which devices exist as replacements for damaged ones.
// The two branches both added this read. DamageCaseView below is the superset
// (it carries opsRemarks, the operator's own note), so that is the one type, and
// DamageCaseRow stays as an alias because the inventory page imports that name.
export type DamageCaseRow = DamageCaseView


// -----------------------------------------------------------------------
// Bank masters, damage-reason master, batching config (Phase 7 Task 8). The
// confirmed ops-edge contract (apps/ops-edge/src/ops-read.controller.ts's
// bankMasters/damageReasons/batchingConfig, grounded against
// services/identity/src/ops.ts listBankMasters/BankMasterRow,
// services/tms/src/damage-reason.ts DamageReasonRow, and
// services/fulfillment/src/ops-read.ts listBatchingConfigs/BatchingConfigRow):
// all three are the SAME class-3 guard-only posture as GET /ops/vendors above
// (no per-op D2 authorize, no 6e; check 3). `GET /ops/bank-config` (the
// separate bank/branch COMPOSITION config, i.e. logo/branding) is a distinct
// route this task does not surface; the brief's read-surface list names
// bank-masters, not bank-config.
//
// THE CREATE HALF LANDED 2026-08-17 (the CREATE writes below). L9 had deferred
// the whole FR-11 admin console, so these reads shipped read-only; the deferral
// was reversed for CREATE only. Edit, suspend, activate and deactivate stay
// deferred and are deliberately absent from this file.
// -----------------------------------------------------------------------

/** services/identity/src/ops.ts BankMasterRow. */
export interface BankMasterRow {
  tnntId: string
  displayName: string
  bankReferenceCode: string
  status: string
  address1: string | null
  address2: string | null
  address3: string | null
  city: string | null
  district: string | null
  country: string | null
  pin: string | null
  mobile: string | null
  email: string | null
  aggregators: AggregatorRow[]
}

export interface AggregatorRow {
  aggrId: string
  tnntId: string
  aggregatorCode: string
  displayName: string
  status: string
  isDefault: boolean
  codeLocked: boolean
  hasLogo: boolean
  address1: string | null
  address2: string | null
  address3: string | null
  city: string | null
  district: string | null
  country: string | null
  pin: string | null
  mobile: string | null
  email: string | null
}

export function getBankMasters(c: Client) {
  return c.request<BankMasterRow[]>({ method: 'GET', path: '/ops/bank-masters' })
}

export interface AggregatorCreateBody {
  displayName: string
  aggregatorCode: string
  address1?: string
  address2?: string
  address3?: string
  city?: string
  district?: string
  country?: string
  pin?: string
  mobile?: string
  email?: string
}

export interface AggregatorEditBody extends Partial<AggregatorCreateBody> {
  status?: string
}

export function createAggregator(c: Client, tnntId: string, body: AggregatorCreateBody, idempotencyKey: string) {
  return c.request<{ deduped: boolean; aggrId: string | null }>({
    method: 'POST',
    path: `/ops/bank-masters/${encodeURIComponent(tnntId)}/aggregators`,
    body,
    idempotencyKey,
  })
}

export function editAggregator(c: Client, aggrId: string, body: AggregatorEditBody, idempotencyKey: string) {
  return c.request<{ deduped: boolean; changedFields: string[] }>({
    method: 'POST',
    path: `/ops/aggregators/${encodeURIComponent(aggrId)}/edit`,
    body,
    idempotencyKey,
  })
}

/**
 * services/tms/src/damage-reason.ts DamageReasonRow. `createdAt`/`updatedAt`
 * are typed `Date` server-side but arrive as JSON strings over the wire,
 * matching every other wire timestamp in this file (e.g. VendorRow above).
 */
export interface DamageReasonRow {
  id: string
  code: string
  label: string
  active: boolean
  createdAt: string
  updatedAt: string
}

export function getDamageReasons(c: Client) {
  return c.request<DamageReasonRow[]>({ method: 'GET', path: '/ops/damage-reasons' })
}

/**
 * services/fulfillment/src/ops-read.ts BatchingConfigRow. `tenantWire`/
 * `programWire` are already wire-encoded strings (or null when the scope
 * does not narrow that far, i.e. GLOBAL/TENANT), never a raw uuid.
 */
export interface BatchingConfigRow {
  id: string
  scope: 'GLOBAL' | 'TENANT' | 'TENANT_PROGRAM' | 'BANK'
  tenantWire: string | null
  programWire: string | null
  /** R-7: set on a BANK-scope row (a per-bank min-lot override), else null. */
  bankReferenceCode: string | null
  minLotSize: number
  /** Null on a BANK-scope row: a bank tier carries min lot only (R-7). */
  maxWaitSeconds: number | null
  createdAt: string
  updatedAt: string
}

export function getBatchingConfig(c: Client) {
  return c.request<BatchingConfigRow[]>({ method: 'GET', path: '/ops/batching-config' })
}

// -----------------------------------------------------------------------
// Master-data CREATE (2026-08-17, the L9 reversal). Four writes behind the
// five Master Data tabs; Vendor Registry and Courier Master share one route
// because a courier IS a vendor row with type COURIER.
//
// Every body below is grounded against the edge's own interface in
// apps/ops-edge/src/ops.controller.ts, never invented here. Each route takes an
// Idempotency-Key and returns the ops-wrapper `{ deduped, <id> }` shape, where
// the id is null on a client-key replay.
// -----------------------------------------------------------------------

/** apps/ops-edge/src/ops.controller.ts VendorCreateBody. */
export interface VendorCreateBody {
  /** services/fulfillment/prisma/schema.prisma Vendor.type. */
  type: 'MANUFACTURER' | 'PRINT' | 'COURIER'
  displayName: string
  /** COURIER-applicable only; unique across vendors, so a duplicate is a 4xx. */
  courierCode?: string
  /** COURIER-applicable only: the integration channel. */
  integrationMode?: 'WEBHOOK' | 'BATCH'
}

export function createVendor(c: Client, body: VendorCreateBody, idempotencyKey: string) {
  return c.request<{ deduped: boolean; vndrId: string | null }>({
    method: 'POST',
    path: '/ops/vendors',
    body,
    idempotencyKey,
  })
}

/**
 * apps/ops-edge/src/ops.controller.ts VendorEditBody (18 Aug 2026). The route
 * existed and was wired end to end before any Master Data tab called it;
 * every field is a partial update, an omitted one left as it was.
 */
export interface VendorEditBody {
  displayName?: string
  courierCode?: string
  integrationMode?: 'WEBHOOK' | 'BATCH'
}

export function editVendor(c: Client, vndrId: string, body: VendorEditBody, idempotencyKey: string) {
  return c.request<{ deduped: boolean }>({
    method: 'POST',
    path: `/ops/vendors/${encodeURIComponent(vndrId)}/edit`,
    body,
    idempotencyKey,
  })
}

/** apps/ops-edge/src/ops.controller.ts BankMasterCreateBody (BRD Annexure D.1). */
export interface BankMasterCreateBody {
  /**
   * The IMMUTABLE ingest resolver key. It must be the code this bank's own
   * FILE resolves to, which for the Annexure B layout is the partner code
   * declared in the profile (`GSCB`), NOT a row's numeric aggregator code. A
   * mismatch does not error: ingest simply auto-mints a SECOND tenant and this
   * record is never used.
   */
  bankReferenceCode: string
  displayName: string
  address1: string
  address2?: string
  address3?: string
  city: string
  district: string
  country: string
  pin: string
  mobile: string
  email: string
}

export function createBankMaster(c: Client, body: BankMasterCreateBody, idempotencyKey: string) {
  return c.request<{ deduped: boolean; tnntId: string | null }>({
    method: 'POST',
    path: '/ops/bank-masters',
    body,
    idempotencyKey,
  })
}

/**
 * apps/ops-edge/src/ops.controller.ts BankMasterEditBody (18 Aug 2026).
 * `bankReferenceCode` is deliberately ABSENT: it is the immutable ingest
 * resolver key (see the doc comment on BankMasterCreateBody above) and the
 * edit route never accepts it.
 */
export interface BankMasterEditBody {
  displayName?: string
  address1?: string
  address2?: string
  address3?: string
  city?: string
  district?: string
  country?: string
  pin?: string
  mobile?: string
  email?: string
  status?: string
}

export function editBankMaster(c: Client, tnntId: string, body: BankMasterEditBody, idempotencyKey: string) {
  return c.request<{ deduped: boolean; changedFields: string[] }>({
    method: 'POST',
    path: `/ops/bank-masters/${encodeURIComponent(tnntId)}/edit`,
    body,
    idempotencyKey,
  })
}

// The logo pair upload (spec 2026-08-19). Multipart through the typed client's
// formBody path (client.ts), so it keeps the 401 refresh-and-retry the raw
// fetch downloads below forgo.
export function uploadAggregatorLogo(
  c: Client,
  aggrId: string,
  master: File,
  derivative: File,
  idempotencyKey: string,
) {
  const form = new FormData()
  form.append('master', master)
  form.append('derivative', derivative)
  return c.request<{ deduped: boolean; id: string | null; masterVersion: string | null; derivativeVersion: string | null }>({
    method: 'POST',
    path: `/ops/aggregators/${encodeURIComponent(aggrId)}/logo`,
    formBody: form,
    idempotencyKey,
  })
}

export interface BankLogoVersionRow {
  version: string
  filename: string
  contentType: string
}

export function getAggregatorLogoVersions(c: Client, aggrId: string) {
  return c.request<BankLogoVersionRow[]>({
    method: 'GET',
    path: `/ops/aggregators/${encodeURIComponent(aggrId)}/logo/versions`,
  })
}

// BINARY body, routed through the client's 'blob' responseType so it gets the
// refresh-on-401-and-retry. These two used raw fetch with a Bearer, and unlike
// the dispatch downloads (a button the operator can click again after a typed
// call refreshes the token) the thumbnail is a passive render: once the access
// token aged out, every logo on the Bank Masters page decayed to
// "unavailable" until a full reload. 404 is a real answer (no logo yet),
// surfaced as null.
export async function fetchAggregatorLogoDerivative(c: Client, aggrId: string): Promise<Blob | null> {
  try {
    return await c.request<Blob>({
      method: 'GET',
      path: `/ops/aggregators/${encodeURIComponent(aggrId)}/logo/derivative`,
      responseType: 'blob',
    })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

// The MASTER bytes at one token from the dialog's history list (the list IS
// the master key's history, so its tokens are only valid against that key;
// the derivative key runs its own version sequence). The caller rasterizes
// the .ai in the browser, exactly like a freshly picked file. Same routed
// shape as above; 404 means an unknown token, surfaced as null.
export async function fetchAggregatorLogoVersionMaster(c: Client, aggrId: string, version: string): Promise<Blob | null> {
  try {
    return await c.request<Blob>({
      method: 'GET',
      path: `/ops/aggregators/${encodeURIComponent(aggrId)}/logo/versions/${encodeURIComponent(version)}/master`,
      responseType: 'blob',
    })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

/** apps/ops-edge/src/ops.controller.ts DamageReasonCreateBody (BRD FR-08). */
export interface DamageReasonCreateBody {
  /** A stable machine identifier, never derived from the label. */
  code: string
  /** The human display text the damage-file ingest matches against. */
  label: string
}

// Returns the created ROW, not just an id, unlike its three neighbours. Null
// on a client-key replay, same as they are.
export function createDamageReason(c: Client, body: DamageReasonCreateBody, idempotencyKey: string) {
  return c.request<{ deduped: boolean; damageReason: DamageReasonRow | null }>({
    method: 'POST',
    path: '/ops/damage-reasons',
    body,
    idempotencyKey,
  })
}

/** apps/ops-edge/src/ops.controller.ts DamageReasonEditBody (18 Aug 2026). */
export interface DamageReasonEditBody {
  code?: string
  label?: string
}

export function editDamageReason(c: Client, id: string, body: DamageReasonEditBody, idempotencyKey: string) {
  return c.request<{ deduped: boolean; damageReason: DamageReasonRow | null }>({
    method: 'POST',
    path: `/ops/damage-reasons/${encodeURIComponent(id)}/edit`,
    body,
    idempotencyKey,
  })
}

/**
 * apps/ops-edge/src/ops.controller.ts BatchingConfigSetBody (BRD 5.3.3).
 *
 * An UPSERT of a tier, not an append: writing the same scope twice replaces
 * that tier's values. Which tier is addressed is implied by which fields are
 * present, so the caller must not send a combination the domain refuses:
 * a BANK tier (bankReferenceCode set) REQUIRES tenantWire and REFUSES
 * maxWaitSeconds, because max wait stays on the pool tiers where the timer
 * that reads it is armed (R-7).
 *
 * ADMIN-TIER: ops:batching-config-set is in ADMIN_TIER_PERMISSIONS, not the
 * shared ops bundle, so a baseline `ops` operator gets a 403 here where the
 * three writes above would succeed.
 */
export interface BatchingConfigSetBody {
  tenantWire?: string
  programWire?: string
  bankReferenceCode?: string
  minLotSize: number
  maxWaitSeconds?: number
}

export function setBatchingConfig(c: Client, body: BatchingConfigSetBody, idempotencyKey: string) {
  return c.request<{ deduped: boolean; id: string | null }>({
    method: 'POST',
    path: '/ops/batching-config',
    body,
    idempotencyKey,
  })
}

// -----------------------------------------------------------------------
// Bank upload (Phase 2 Task 4). The confirmed ops-edge contract
// (apps/ops-edge/src/ops.controller.ts's previewBank/commitBank, grounded
// against services/tms/src/ops.ts and bank-file-adapter.ts): the upload
// surface is MULTIPART raw-file routes with server-side parsing (D-K); no
// client-side parsing of the picked file remains authoritative.
//   POST /ops/uploads/bank/preview     multipart `file`, no Idempotency-Key,
//     writes nothing -> BankPreviewResult { rows, summary, structuralErrors }
//   POST /ops/uploads/bank/commit      multipart `file`, Idempotency-Key
//     -> { accepted, quarantined, duplicate, qrMalformed, fileId }
// (The damage upload surface that used to sit beside these is GONE: D-25
// voided damage file ingestion entirely, and D-26 replaced it with the
// operator flagging a dispatch directly. See flagDamage below.)
// This is a raw `fetch`, not the JSON api client (createApiClient/
// client.request), which only ever sends application/json bodies: it mirrors
// apps/vendor-portal ReturnUploadPage.tsx's multipart-from-SPA pattern
// (FormData with a `file` part + a Bearer header read straight off
// tokenStore). None of these routes is step-up-gated.
// -----------------------------------------------------------------------

/**
 * services/tms/src/ingest.ts RequestRowRejectReason. Kept in sync by hand: the
 * portal cannot import from a service (no cross-context dependency), so a guard
 * test asserts this union matches the service's own list exactly.
 *
 * P-A: previously this listed only TWO of the codes the service could actually
 * return, so `missing_branch_code` had been reachable on the wire and absent
 * from the type since Phase 3. That drift is what the parity guard now prevents.
 */
export type RequestRowRejectReason =
  | 'invalid_qr_vpa_format'
  | 'missing_display_name'
  | 'missing_legal_name'
  | 'missing_registered_address'
  | 'missing_contact_name'
  | 'missing_mobile'
  | 'invalid_mobile_format'
  | 'invalid_category_code_format'
  | 'invalid_bank_code_format'
  | 'missing_branch_code'
  | 'invalid_branch_code_format'
  | 'invalid_standee_count'
  | 'invalid_sticker_count'
  | 'duplicate_vpa_soundbox'

/**
 * services/tms/src/ingest.ts DuplicateVpaOriginal: the record a held soundbox
 * row collides with (ruling 2026-08-10). `reference` is per-kind and is already
 * display-ready: a WIRE asgn id for an `assignment`, the `{file_id}|{row_no}`
 * correlation id for a `pending_row`, and a plain row number for a `file_row`
 * (an earlier row of the very file being previewed or committed).
 * `merchantDisplayName` is null when the original has no name to show.
 */
export interface DuplicateVpaOriginal {
  kind: 'assignment' | 'pending_row' | 'file_row'
  reference: string
  merchantDisplayName: string | null
}

/** services/tms/src/ops.ts PreviewRowResult: one row's preview verdict. */
export interface PreviewRowResult {
  rowNo: number
  valid: boolean
  errors: RequestRowRejectReason[]
  row: BankRequestRow
  // Present only on a `duplicate_vpa_soundbox` verdict. A SIBLING of `row` and
  // never a field inside it: BankUploadPage derives the preview table's columns
  // reflectively from Object.keys(row), so anything added to `row` would become
  // a phantom bank-file column.
  duplicateOf?: DuplicateVpaOriginal
}

/** services/tms/src/bank-file-adapter.ts StructuralParseError: a whole-file problem. */
export type StructuralParseErrorCode = 'unsupported_extension' | 'unreadable_file' | 'missing_required_column'
export interface StructuralParseError {
  code: StructuralParseErrorCode
  message: string
}

/** services/tms/src/ops.ts BankPreviewResult. */
export interface BankPreviewResult {
  rows: PreviewRowResult[]
  summary: { total: number; valid: number; invalid: number }
  structuralErrors: StructuralParseError[]
}

export interface BankCommitResult {
  accepted: number
  quarantined: number
  duplicate: number
  // D-8: how many rows the BANK sent with an HTML-escaped QR separator. Not an
  // outcome count (those rows ingest normally and the payload is corrected
  // downstream); it is the evidence the D4 ruling asks for so the defect can be
  // raised with GSCB instead of staying silent. Rendered by PerRowErrors only
  // when non-zero, so it disappears if the bank ever fixes their export.
  qrMalformed: number
  // D-2: rows whose VPA we have seen before, in this file or an earlier upload.
  // Every repeat is counted here, HELD OR NOT: it is evidence about what the
  // file contained. Since the 2026-08-10 ruling this is no longer the same thing
  // as "accepted": subtract duplicateVpaHeld.length to get the flag-only
  // remainder that really did ingest (PerRowErrors does exactly that).
  duplicateVpa: number
  // Ruling 2026-08-10: the SOUNDBOX rows this file HELD for a repeat VPA, each
  // naming the record it collides with. A sticker/standee row is never held for
  // a repeat, so a file that repeats a VPA only on collateral rows reports an
  // empty list here and a non-zero duplicateVpa above.
  duplicateVpaHeld: { rowNo: number; duplicateOf: DuplicateVpaOriginal }[]
  // Rows whose MOBILE was already used by a DIFFERENT merchant. A separate
  // signal from duplicateVpa: that one is the same merchant returning, this is
  // two merchants sharing a contact number.
  duplicateMobile: number
  fileId: string
}

// -----------------------------------------------------------------------
// Device-inventory upload (Phase 7 Task 7; edge built Phase-5 Task 1, D-G,
// FR-01a). The confirmed ops-edge contract (apps/ops-edge/src/ops.controller.ts's
// uploadDeviceInventory, grounded against services/fulfillment/src/ops-device-inventory.ts):
//   POST /ops/uploads/device-inventory   multipart `file` + a `manufacturerVndrId`
//     form field, Idempotency-Key required -> OpsDeviceInventoryResult
// Since the 12 Aug 2026 walkthrough (Workflow A, FROZEN) the ONLY row
// validation is Device ID presence; Sim No and Device QR are optional
// pass-through columns. A row with a blank Device ID is reported per-row here
// (invalidRows) and never ingested, WITHOUT failing the whole file.
// manufacturerVndrId is a WIRE vndr id (B_edge_contracts.md item 4), the SAME
// shape GET /ops/vendors emits, so the SPA sources it from getVendors filtered
// to type === 'MANUFACTURER' (never a raw uuid, never hand-typed).
// -----------------------------------------------------------------------

/**
 * services/fulfillment/src/device-inventory-adapter.ts DeviceInventoryRowErrorCode.
 * One code since the 12 Aug 2026 walkthrough; the screen needs no label map
 * because StatusPill humanises the code.
 */
export type DeviceInventoryRowErrorCode = 'missing_device_id'

export interface DeviceInventoryRowError {
  rowNo: number
  errors: DeviceInventoryRowErrorCode[]
}

/**
 * One duplicate row, by its original sheet row number, with the
 * intake_exception reason code(s). The four codes the server raises today:
 * duplicate_device_serial_in_file, duplicate_device_serial_existing_unit
 * (no second device is created for either), duplicate_sim_no_in_file and
 * duplicate_sim_no_existing_unit (the device IS created, without a SIM).
 */
export interface DeviceInventoryFlaggedRow {
  rowNo: number
  errors: string[]
}

/** services/fulfillment/src/ops-device-inventory.ts OpsDeviceInventoryResult. */
export interface DeviceInventoryUploadResult {
  fileId: string
  accepted: number
  flagged: number
  invalid: number
  createdUnitIds: string[]
  invalidRows: DeviceInventoryRowError[]
  flaggedRows: DeviceInventoryFlaggedRow[]
  // How many of `invalid` were also queued into intake_exception so an
  // operator can correct them from Queues rather than losing the row the
  // moment they navigate away from this screen.
  queuedForReview: number
  deduped: boolean
}

/**
 * A whole-file (STRUCTURAL) rejection, as opposed to the per-row `invalidRows`
 * above. A structural failure ingests nothing, so it arrives as a 400 rather
 * than in a result body.
 *
 * The edge sends only the `code` and, for a missing column, its canonical
 * `column` name. It deliberately does NOT send the server's own error text,
 * because that text embeds the uploaded filename for two of the three codes and
 * a caller-supplied value must not ride an HTTP response (S4/5c). The operator-
 * facing wording therefore lives in the portal, next to the rest of the UI copy.
 */
export type DeviceInventoryStructuralCode =
  | 'unsupported_extension'
  | 'unreadable_file'
  | 'missing_required_column'

export interface DeviceInventoryStructuralReason {
  code: DeviceInventoryStructuralCode | string
  column?: string
}

/**
 * Pulls the structural reasons out of a rejected upload. Returns [] for any
 * other failure (a 500, an auth error, a network drop), so the caller can fall
 * back to its generic message and a structural rejection is never confused
 * with an unrelated one.
 */
export function deviceInventoryStructuralReasons(err: unknown): DeviceInventoryStructuralReason[] {
  if (!(err instanceof ApiError) || err.status !== 400) return []
  const body = err.body
  if (typeof body !== 'object' || body === null) return []
  const raw = (body as { reasons?: unknown }).reasons
  if (!Array.isArray(raw)) return []
  const out: DeviceInventoryStructuralReason[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const { code, column } = item as { code?: unknown; column?: unknown }
    if (typeof code !== 'string' || code === '') continue
    out.push(typeof column === 'string' && column !== '' ? { code, column } : { code })
  }
  return out
}

/**
 * The reason code on a 409, or null when the refusal carried none.
 *
 * The sibling of deviceInventoryStructuralReasons above, for the other status
 * the edge lets a closed reason code cross on (added 19 Aug 2026). A conflict is
 * the status where the operator's next move depends entirely on WHICH rule
 * refused, and the domain message never crosses the boundary by design (S4/5c),
 * so without this every conflict read as the same generic sentence.
 *
 * Returns the FIRST code only: a lifecycle action is refused by one rule at a
 * time, unlike an upload whose sheet can fail several structural checks at once.
 * Any other failure returns null so the caller falls back to its own wording and
 * a conflict is never confused with an unrelated error.
 */
export function conflictReasonCode(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null
  const body = err.body
  if (typeof body !== 'object' || body === null) return null
  const raw = (body as { reasons?: unknown }).reasons
  if (!Array.isArray(raw)) return null
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const { code } = item as { code?: unknown }
    if (typeof code === 'string' && code !== '') return code
  }
  return null
}

// The 5 MB multipart cap the ops-edge FileInterceptor enforces
// (apps/ops-edge/src/deps.ts MAX_UPLOAD_BYTES). Checked client-side against
// File.size BEFORE any network call, so an oversized file never posts.
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

// The only two sheet formats any adapter can read (every adapter's own
// detectFormat: .csv or .xlsx, else `unsupported_extension`).
export const ACCEPTED_UPLOAD_EXTENSIONS = ['.csv', '.xlsx'] as const

/**
 * One client-side gate for every upload surface: too big, or not a sheet.
 * Returns the operator-facing message, or null when the file may be posted.
 *
 * THE TYPE HALF IS NOT COSMETIC (2026-08-13 audit). `FileDropZone`'s `accept`
 * attribute only filters the file-PICKER dialog: a drag-and-drop hands over
 * whatever was dropped, and the picker itself can be switched to "All files".
 * So before this, dropping a .txt or a .zip posted it and the operator learned
 * it was wrong only from a server 400. The server still rejects it (it stays
 * the authority); this just stops the pointless round trip and answers
 * instantly, with the same wording the server's own code maps to.
 */
export function uploadFileRejection(file: File): string | null {
  const name = file.name.toLowerCase()
  if (!ACCEPTED_UPLOAD_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return 'Unsupported file type. Upload a .csv or .xlsx file.'
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return 'File exceeds the 5 MB upload limit. Split it into smaller files and try again.'
  }
  return null
}

function opsBaseUrl(): string {
  return opsBase()
}

// The shared raw multipart POST (mirrors ReturnUploadPage's fetch): a
// FormData `file` part, an optional set of additional plain-string form
// fields (device-inventory's `manufacturerVndrId`), a Bearer header read
// straight off tokenStore (never the JSON client, which always sets
// Content-Type: application/json), and an optional Idempotency-Key header
// for the commit routes (a preview route never sends one; it is a pure
// read).
// ROUTED THROUGH THE CLIENT, NOT RAW fetch.
//
// This used to call `fetch` directly, which meant the upload routes were the
// only calls in the portal that did NOT get client.ts's refresh-on-401-and-
// retry. With a 600 second access token that made every upload fail about ten
// minutes after the last refresh, with a hard 401 and no retry. It was found by
// driving the real system: a bank file would not save, and auth.authz_audit
// showed no ops:upload-bank-file decision at all, only `authenticate` DENYs.
// The request never reached the authorization gate.
//
// Going through the client also fixes a second defect for free. The old line
// was `Bearer ${getAccessToken()}` with no null check, and client.ts sets the
// token to null after a failed refresh, so a later upload sent the literal
// string "Bearer null". sendOnce omits the header entirely when no token is held.
async function postFile<T>(
  c: Client,
  path: string,
  file: File,
  idempotencyKey?: string,
  extraFields?: Record<string, string>,
): Promise<T> {
  const form = new FormData()
  form.append('file', file, file.name)
  if (extraFields !== undefined) {
    for (const [key, value] of Object.entries(extraFields)) form.append(key, value)
  }
  // The SAME FormData instance is reused if the client retries after a refresh.
  // That is deliberate and safe: FormData holds the File by reference and is
  // re-serialised per attempt, so the retry carries the whole payload again.
  return c.request<T>({ method: 'POST', path, formBody: form, ...(idempotencyKey !== undefined ? { idempotencyKey } : {}) })
}

export function previewBank(c: Client, file: File): Promise<BankPreviewResult> {
  return postFile<BankPreviewResult>(c, '/ops/uploads/bank/preview', file)
}

export function commitBank(c: Client, file: File, idempotencyKey: string): Promise<BankCommitResult> {
  return postFile<BankCommitResult>(c, '/ops/uploads/bank/commit', file, idempotencyKey)
}

/**
 * The print vendor's return sheet, uploaded by an OPERATOR (D-25, BRD FR-05
 * para 322: in Phase 1 the vendor emails it and our team uploads it).
 *
 * services/fulfillment/src/return-sheet-adapter.ts ReturnSheetParseResult, plus
 * the ops ingest outcome. Note what is NOT on the wire: the print vendor. It is
 * resolved server-side from the batch these dispatch ids belong to, so there is
 * nothing for an operator to pick and nothing for a caller to assert.
 */
export interface ReturnSheetRowError {
  rowNo: number
  message: string
}

export interface ReturnPreviewResult {
  validRows: Array<{ asgnId: string; deviceSerial?: string; awb: string; courierCode?: string }>
  invalidRows: ReturnSheetRowError[]
  structuralErrors: StructuralParseError[]
}

export interface ReturnCommitResult {
  /** Whole-file refusals. Absent on a (possibly partial) accept. */
  rejected?:
    | 'schema_invalid'
    | 'no_resolvable_dispatch'
    | 'mixed_vendors'
    | 'batch_has_no_vendor'
    // Sent WITH a batchId and at least one row belongs to another batch, or to
    // no batch at all. Mirrors OpsReturnRejection in
    // services/fulfillment/src/return-sheet.ts.
    | 'foreign_dispatch'
  /** The print vendor the sheet resolved to, once resolution succeeded. */
  vndrId?: string
  pairedUnitIds: string[]
  quarantined: number
  shptIds: string[]
  collateralLinked: number
  deduped: boolean
  invalidRows: ReturnSheetRowError[]
}

export function previewReturnUpload(c: Client, file: File): Promise<ReturnPreviewResult> {
  return postFile<ReturnPreviewResult>(c, '/ops/uploads/return/preview', file)
}

/**
 * Commit a print-vendor return sheet.
 *
 * `batchId` is sent when the operator uploaded from a BATCH's own return page,
 * and the server then refuses the whole file if any row's dispatch belongs
 * elsewhere ('foreign_dispatch'). Omitted from the generic Uploads entry, where
 * there is no batch in hand.
 *
 * It is an intent assertion, not an authorization scope: the caller says which
 * batch this sheet is about and the server checks the claim against the
 * dispatches it already resolves for vendor binding. Scope itself still comes
 * from the principal (M7/S16). Until 19 Aug 2026 this claim was checked ONLY in
 * the browser, so the page's own promise that a foreign row refuses the sheet
 * was cosmetic.
 */
export function commitReturnUpload(
  c: Client,
  file: File,
  idempotencyKey: string,
  batchId?: string,
): Promise<ReturnCommitResult> {
  return postFile<ReturnCommitResult>(
    c,
    '/ops/uploads/return',
    file,
    idempotencyKey,
    batchId === undefined || batchId === '' ? undefined : { batchId },
  )
}

/**
 * services/fulfillment/src/ops-device-inventory.ts DeviceInventoryPreviewRow.
 * The preview writes NOTHING: it parses the sheet with the same parser the
 * commit uses and compares each row against stock we already hold, so an
 * operator can see what the file contains, and what will happen to it, before
 * committing. The SIM arrives in full, unmasked (admin console).
 */
export interface DeviceInventoryPreviewRow {
  rowNo: number
  deviceId: string
  simNo: string
  deviceQr: string
  errors: string[]
  alreadyInStock: boolean
  simAlreadyUsed: boolean
  duplicateInFile: boolean
}

export interface DeviceInventoryPreview {
  rows: DeviceInventoryPreviewRow[]
  totalRows: number
  willAdd: number
  willFlag: number
  willReject: number
}

// No Idempotency-Key: a preview writes nothing, so there is nothing to dedupe.
export function previewDeviceInventory(c: Client, file: File): Promise<DeviceInventoryPreview> {
  return postFile<DeviceInventoryPreview>(c, '/ops/uploads/device-inventory/preview', file)
}

export function commitDeviceInventory(
  c: Client,
  file: File,
  manufacturerVndrId: string,
  idempotencyKey: string,
): Promise<DeviceInventoryUploadResult> {
  return postFile<DeviceInventoryUploadResult>(c, '/ops/uploads/device-inventory', file, idempotencyKey, {
    manufacturerVndrId,
  })
}

// D-17 (T5.1): the courier's morning status file, uploaded by ops.
//
// The result splits two kinds of failure that an operator fixes differently.
// `invalid` rows are ones the FILE got wrong (a blank AWB, an unreadable date):
// they never reached the delivery rail and are fixed by correcting the file.
// `quarantined` rows DID reach it and were held there (an AWB we do not know,
// the wrong courier): they are worked from the exceptions queue.
export interface CourierStatusUploadResult {
  fileId: string
  advanced: number
  trailOnly: number
  quarantined: number
  invalid: number
  invalidRows: { rowNo: number; errors: string[] }[]
  deduped: boolean
}

export function commitCourierStatus(
  c: Client,
  file: File,
  courierVndrId: string,
  idempotencyKey: string,
): Promise<CourierStatusUploadResult> {
  return postFile<CourierStatusUploadResult>(c, '/ops/uploads/courier-status', file, idempotencyKey, {
    courierVndrId,
  })
}

/**
 * services/fulfillment/src/ops-unit-status.ts. Bulk unit-status correction:
 * a sheet of Device ID + New Status, one row per device, same forward-only
 * guard as the single-device edit. Preview writes nothing.
 */
export interface UnitStatusPreviewRow {
  rowNo: number
  deviceId: string
  newStatus: string
  currentStatus: string | null
  legal: boolean
  errors: string[]
}

export interface UnitStatusPreview {
  rows: UnitStatusPreviewRow[]
  totalRows: number
  willMove: number
  willReject: number
}

export function previewUnitStatus(c: Client, file: File): Promise<UnitStatusPreview> {
  return postFile<UnitStatusPreview>(c, '/ops/uploads/unit-status/preview', file)
}

export interface UnitStatusResultRow {
  rowNo: number
  deviceId: string
  outcome: 'moved' | 'not_found' | 'illegal_transition' | 'invalid'
  errors: string[]
}

export interface UnitStatusUploadResult {
  fileId: string
  totalRows: number
  moved: number
  skipped: number
  rows: UnitStatusResultRow[]
  deduped: boolean
}

export function commitUnitStatus(c: Client, file: File, idempotencyKey: string): Promise<UnitStatusUploadResult> {
  return postFile<UnitStatusUploadResult>(c, '/ops/uploads/unit-status', file, idempotencyKey)
}

// -----------------------------------------------------------------------
// Operational actions (Task 14). The confirmed ops-edge contract
// (apps/ops-edge/src/ops.controller.ts): four gated writes (Idempotency-Key
// header required, D2 authorize), NONE step-up-gated (`ops:manual-batch-trigger`,
// `ops:status-correction`, `ops:recompose-artifact`, `ops:record-hold` are all
// absent from OPS_STEP_UP_GATED_OPERATIONS; the step-up-gated
// terminal-override/hold-release/vendor-suspend counterparts are Task 15).
// -----------------------------------------------------------------------

export interface BatchTriggerBody {
  tenantWire: string
  programWire: string
  // BRD 5.3.4 force dispatch: REQUIRED, and the edge 400s a blank or >500
  // character value before it even runs the authorization gate. Free text; it
  // is stored on the batch row, never on the 6e authz record.
  reason: string
}

export function triggerBatch(c: Client, body: BatchTriggerBody, idempotencyKey: string) {
  return c.request<{ btchId: string } | null>({
    method: 'POST',
    path: '/ops/batches/trigger',
    body,
    idempotencyKey,
  })
}

/**
 * Hand a formed batch to its print vendor (D4, 18 Aug 2026). No body: this is
 * the designed forward step of the batch lifecycle, not an override, so no
 * reason is owed (contrast triggerBatch and holdRecord above).
 *
 * `sent` false with `deduped` true is a replay of the same idempotency key.
 * The edge answers 409 when the batch has already been sent, when its QR
 * generation has not finished, or when the print vendor roster does not hold
 * exactly one active vendor.
 */
export function sendBatchToVendor(c: Client, btchId: string, idempotencyKey: string) {
  return c.request<{ deduped: boolean; sent: boolean }>({
    method: 'POST',
    path: `/ops/batches/${encodeURIComponent(btchId)}/send-to-vendor`,
    idempotencyKey,
  })
}

/**
 * Close a batch whose dispatches have all settled (D5, 18 Aug 2026).
 *
 * The edge answers 409 when any dispatch is still in flight, and the message
 * names how many, so the refusal can be shown as-is. Also 409 when the batch is
 * already closed.
 */
export function closeBatch(c: Client, btchId: string, idempotencyKey: string) {
  return c.request<{ deduped: boolean; closed: boolean }>({
    method: 'POST',
    path: `/ops/batches/${encodeURIComponent(btchId)}/close`,
    idempotencyKey,
  })
}

export interface StatusCorrectionBody {
  status: string
  courierTimestamp: string
}

export function correctStatus(c: Client, id: string, body: StatusCorrectionBody, idempotencyKey: string) {
  return c.request<{ deduped: boolean; outcome: string | null }>({
    method: 'POST',
    path: `/ops/shipments/${id}/correct`,
    body,
    idempotencyKey,
  })
}

// The batch-wide "mark all delivered" shortcut (19 Aug 2026, demo need). One
// call, POST /ops/batches/:id/deliver-all, corrects every shipment in the
// batch to DELIVERED; the summary names how many actually moved.
export function bulkDeliverBatch(c: Client, batchId: string, idempotencyKey: string) {
  return c.request<{ delivered: number; skipped: number; failed: number }>({
    method: 'POST',
    path: `/ops/batches/${batchId}/deliver-all`,
    idempotencyKey,
  })
}

export interface RecomposeBody {
  asgnId: string
  artifactType: string
  requestedShipTo?: string
}

export function recompose(c: Client, body: RecomposeBody, idempotencyKey: string) {
  return c.request<{ deduped: boolean; artifactId: string | null }>({
    method: 'POST',
    path: '/ops/artifacts/recompose',
    body,
    idempotencyKey,
  })
}

// NO body: the edge route (apps/ops-edge/src/ops.controller.ts's `hold`)
// takes only the `:asgnId` path param.
// 12 Aug 2026: the hold carries its reason, like the batch trigger does. The
// edge rejects a blank one before it authorizes anything, so this is required
// rather than optional.
export function holdRecord(c: Client, asgnId: string, reason: string, idempotencyKey: string) {
  return c.request<{ deduped: boolean }>({
    method: 'POST',
    path: `/ops/records/${asgnId}/hold`,
    body: { reason },
    idempotencyKey,
  })
}

// -----------------------------------------------------------------------
// Activation (Task 11, Phase 7, FR-07/D-H.1 SUCCESS mark). The confirmed
// ops-edge contract (apps/ops-edge/src/ops.controller.ts's
// activateAssignmentRoute): POST /ops/assignments/activate, body
// `{ dispatchId }`. The field is named dispatchId on the wire but IS the
// wire asgn id - the exact same `dispatchId` string the `activation` report
// row already emits (services/analytics/src/mediation.ts's activationRow),
// per docs/plan/phase7_grounding/B_edge_contracts.md row #11 ("MATCH
// (wire)"). NOT step-up-gated (`ops:mark-activated` is absent from
// OPS_STEP_UP_GATED_OPERATIONS). The DELIVERED gate (deliveryDate IS NOT
// NULL) is read and enforced SERVER-SIDE at the edge, off its own local
// analyticsDb projection (never a cross-context TMS read, C4); the
// onceWithin business key `${asgnId}|activate` is also server-side
// (activateAssignmentWithinTx). This client function only sends the id and
// a fresh request-level Idempotency-Key, exactly like every other gated
// write below - it does not, and cannot, construct either server-side key.
// -----------------------------------------------------------------------

export function markActivated(c: Client, dispatchId: string, idempotencyKey: string) {
  return c.request<{ activated: boolean }>({
    method: 'POST',
    path: '/ops/assignments/activate',
    body: { dispatchId },
    idempotencyKey,
  })
}

// -----------------------------------------------------------------------
// Dispatch package downloads (Task 9, Phase 7). The two ops-edge routes
// (apps/ops-edge/src/ops-read.controller.ts's dispatchExcel/collateral) are
// guard-only reads (no D2 authorize, no 6e, no Idempotency-Key) that return
// a BINARY body (xlsx / pdf), never JSON - so they cannot go through the
// typed `client.request` (JSON/text only; client.ts is a SPINE_FILE this
// task does not touch). Mirrors postFile's raw-fetch-with-Bearer pattern
// above instead. `:btchId` is the wire `btch_...` id BatchPage's own trigger
// response already returns (`{ btchId }`). SUPERSEDED IN PART (P2-1): when
// this was written no ops-edge read exposed a batch id at all, so that
// trigger response, or an id the operator already held, was the only real
// non-fabricated source. `getBatches` above is now a genuine discovery read,
// and the batch detail hub calls both downloads with an id the operator
// SELECTED rather than typed.
// -----------------------------------------------------------------------

export interface DownloadedFile {
  blob: Blob
  filename: string
}

function filenameFromContentDisposition(res: Response, fallback: string): string {
  const header = res.headers.get('Content-Disposition')
  if (header === null) return fallback
  const match = /filename="([^"]+)"/.exec(header)
  return match?.[1] ?? fallback
}

// E1 (2026-08-10): one Excel per delivery group, same group grammar as the
// collateral PDF download below. 404 (no such group) surfaces as null, not
// thrown, exactly as downloadCollateral documents.
export async function downloadDispatchExcel(btchId: string, group: string): Promise<DownloadedFile | null> {
  const res = await fetch(`${opsBaseUrl()}/ops/batches/${btchId}/excel/${group}`, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const text = await res.text()
    throw new ApiError(res.status, text === '' ? null : JSON.parse(text))
  }
  const blob = await res.blob()
  return { blob, filename: filenameFromContentDisposition(res, `${btchId}-dispatch-${group.toLowerCase()}.xlsx`) }
}

// D-16 (T4.1b): the activation sheet for ONE batch, the file ops sends the CWD.
//
// GET /ops/reports/activation/batch/:btchId/xlsx, returning the xlsx media type
// with `Content-Disposition: attachment; filename="<btchId>-activation.xlsx"`.
// It is a BINARY body, so it takes the same raw-fetch-with-Bearer path as the
// two dispatch-package downloads above and for the same recorded reason: the
// typed `client.request` carries JSON/text only, and client.ts is a SPINE_FILE
// this work does not touch. The consequence is worth stating rather than
// rediscovering: a request that lands on an EXPIRED access token gets no
// 401-refresh-and-retry here, because that interceptor lives inside
// client.request. It surfaces as an ApiError the caller renders, and the
// operator clicks the button again after the next typed call has refreshed.
//
// `btchId` is percent-encoded even though a wire `btch_` id is
// path-safe by construction: the encode costs nothing and means an id that ever
// gains a new character cannot smuggle a path segment into the URL.
//
// 404 is a REAL ANSWER here, not a failure: the edge returns it when that batch
// has nothing awaiting activation. Surfacing it as `null` rather than throwing
// is the same contract downloadCollateral documents below, so the caller can say
// so in a sentence instead of showing an error.
export async function downloadActivationSheet(btchId: string): Promise<DownloadedFile | null> {
  const res = await fetch(`${opsBaseUrl()}/ops/reports/activation/batch/${encodeURIComponent(btchId)}/xlsx`, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const text = await res.text()
    throw new ApiError(res.status, text === '' ? null : JSON.parse(text))
  }
  const blob = await res.blob()
  return { blob, filename: filenameFromContentDisposition(res, `${btchId}-activation.xlsx`) }
}

// 404 (no artifact of that type for the batch) is a real, non-error outcome
// - the edge itself returns 404 deliberately (ops-read.controller.ts's
// collateral route) rather than an empty/500 - so it is surfaced as `null`,
// not thrown.
export async function downloadCollateral(btchId: string, artifactType: string): Promise<DownloadedFile | null> {
  const res = await fetch(`${opsBaseUrl()}/ops/batches/${btchId}/collateral/${artifactType}`, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const text = await res.text()
    throw new ApiError(res.status, text === '' ? null : JSON.parse(text))
  }
  const blob = await res.blob()
  return { blob, filename: filenameFromContentDisposition(res, `${btchId}-${artifactType.toLowerCase()}.pdf`) }
}

// -----------------------------------------------------------------------
// Destructive actions (Task 15). The confirmed ops-edge contract (task 15
// brief, grounded against apps/ops-edge/src/ops.controller.ts): three gated
// writes (Idempotency-Key header required, D2 authorize) that are ALSO
// step-up-gated ('terminal-override', 'hold-release', 'vendor-suspend', the
// exact three entries of OPS_STEP_UP_GATED_OPERATIONS, imported by
// ../api/client.ts). Each `stepUpKey` below is what makes the client's 403
// interceptor drive the TOTP dialog and retry once with the same
// Idempotency-Key; nothing here evaluates authorization itself (S24/T14).
// -----------------------------------------------------------------------

export interface TerminalOverrideBody {
  status: string
  courierTimestamp: string
  overrideReason: string
}

export function overrideTerminal(c: Client, id: string, body: TerminalOverrideBody, idempotencyKey: string) {
  return c.request<{ deduped: boolean; overridden: boolean }>({
    method: 'POST',
    path: `/ops/shipments/${id}/override`,
    body,
    idempotencyKey,
    stepUpKey: 'terminal-override',
  })
}

// NO body: only the `:asgnId` path param, mirroring holdRecord's shape.
export function releaseHold(c: Client, asgnId: string, idempotencyKey: string) {
  return c.request<{ deduped: boolean; released: boolean }>({
    method: 'POST',
    path: `/ops/records/${asgnId}/release`,
    idempotencyKey,
    stepUpKey: 'hold-release',
  })
}

// NO body: only the `:id` path param.
export function suspendVendor(c: Client, id: string, idempotencyKey: string) {
  return c.request<{ deduped: boolean }>({
    method: 'POST',
    path: `/ops/vendors/${id}/suspend`,
    idempotencyKey,
    stepUpKey: 'vendor-suspend',
  })
}

// -----------------------------------------------------------------------
// The batch-journey rollup (workflow workspace, 2026-08-11 ruling). The
// confirmed ops-edge contract: GET /ops/reports/batch-journey/:btchId on
// ReportsController, grounded against services/analytics/src/mediation.ts's
// readBatchJourney / BatchJourneyView.
//
// It lives under /ops/reports and NOT under /ops/batches deliberately. It is an
// analytics-mediated CROSS-TENANT read, so guardrail G3 binds it to emit both
// the per-read analytics 6e and the D99 cross-tenant-access entry, which is
// ReportsController's documented posture. OpsReadController is pinned by its own
// test to emit NO audit at all ("reads are NOT mutations", check 3), so putting
// it there would have broken that posture to buy a prettier URL.
//
// Scope is re-derived from the verified claim at the edge (D99); nothing here
// sends a program, tenant or batch scope. Carries the D100 freshness watermark
// on the body, like every other mediated read.
//
// PII-free by construction: the projection holds no ship-to, contact name,
// mobile or raw qr/vpa, so none can be rendered. `merchantDisplay` is the same
// field the soundbox-delivery report already exposes, so it adds no entitlement.
// -----------------------------------------------------------------------

/** services/analytics/src/mediation.ts BatchJourneyView. */
export interface BatchJourneyView {
  batchId: string
  /**
   * CUMULATIVE stage counts: a DELIVERED record has also been sent to vendor and
   * dispatched, so it is counted in all three. This is what lets the rail mark a
   * stage complete only when nobody is still behind it.
   */
  counts: {
    total: number
    /**
     * The rows that CAN reach DELIVERED and CAN be activated, which is a SUBSET
     * of `total` and is the denominator stages 7 and 8 of the workflow rail
     * measure against. Analytics owns the predicate (isSoundboxOrLegacy); the
     * portal consumes this number and never re-expresses it, so there is no
     * second definition of "deliverable" to drift.
     *
     * It exists because `delivered` and `total` are at different grains.
     * Delivery is tracked on the DEVICE parcel, so a COLLATERAL group (sticker
     * plus standee) ships and delivers under its own AWB but never carries a
     * merchant to DELIVERED, and never activates at all. Observed live on
     * 2026-08-11: a batch of 5 bank requests was 10 rows, all 10 shipments
     * reached DELIVERED, and this read answered total 10 with delivered 5, so
     * `delivered === total` was unreachable for any batch carrying collateral,
     * which is every real batch.
     *
     * ONE FIELD FOR BOTH STAGES: the same predicate gates delivery and
     * activation, so two fields would always hold the same number and would only
     * give the two a way to drift apart.
     */
    deliverableAndActivatable: number
    sentToVendor: number
    dispatched: number
    delivered: number
    activated: number
  }
  /** The courier fan-out. `exception` is terminal-but-not-delivered (RTO, FAILED). */
  courier: {
    pickedUp: number
    inTransit: number
    outForDelivery: number
    delivered: number
    exception: number
  }
  /**
   * `simActivated` is ALWAYS null, never 0: sim_activation_status has no write
   * path anywhere, so a number would be invented. The workspace renders this as
   * "Not available yet", the same treatment TilesPage gives its two
   * activation-empty tiles.
   */
  activation: {
    awaiting: number
    activated: number
    failed: number
    simActivated: null
  }
  /**
   * When this batch was FIRST sent to the print vendor: the earliest non-null
   * sent_to_vendor_at across its rows, or null when no row carries one yet.
   *
   * Null renders as an ABSENCE. Never substitute batch.createdAt (when the batch
   * FORMED, an earlier and different fact) or batch.updatedAt (which moves for
   * unrelated reasons); the Print stage had no timestamp at all until this field
   * existed, precisely because those two were the only alternatives.
   */
  sentToVendorAt: string | null
  /** The stage-8 worklist: delivered, not yet activated. */
  awaitingActivation: {
    dispatchId: string
    merchantDisplay: string
    awb: string | null
    deliveryDate: string | null
  }[]
  watermark: Watermark
}

// 404 when the batch has no rows in the analytics projection, mirroring
// getBatchDetail: the caller can tell "no such batch" from "a batch at stage
// zero" rather than reading an empty-but-valid-looking body.
// D-16 (T4.5): ONE Dispatch ID's two branches with the full history under each.
// The edge composes it from three contexts; the shape below mirrors that
// response and invents nothing.
// TWO CLOCKS PER TRAIL ROW (S22), and both are now mirrored. The edge has always
// sent `sourceRef` and `receivedAt` on a courier event and `recordedAt` on an
// activation event; this interface dropped all three, so the page could not tell
// WHEN A COURIER SAYS something happened from WHEN WE WERE TOLD, which is exactly
// the distinction those columns exist to keep. A backdated file import looks
// identical to a live webhook without it.
//
// (The former `DispatchTrailEntry` type sat here unused by anything, describing a
// third shape neither trail has. Removed rather than left to be copied.)
export interface DeliveryTrailEntry {
  status: string
  /** The courier's own reported instant. */
  courierTimestamp: string
  statusSource: string
  /** The channel's reference: a vendor and file id, an event id, or an actor. */
  sourceRef: string
  /** When the platform recorded it. */
  receivedAt: string
  overrideReason: string | null
}

export interface ActivationTrailEntry {
  status: string
  /** The reported instant (the CWD's own). */
  occurredAt: string
  statusSource: string
  actorId: string | null
  /** When the platform recorded it. */
  recordedAt: string
}

export interface DispatchDetailView {
  dispatchId: string
  dispatchGroup: string | null
  bankCode: string
  bankDisplay: string
  merchantDisplay: string
  deviceIds: string[]
  batchId: string | null
  awb: string | null
  shptId: string | null
  dispatchDate: string | null
  courierStatus: string | null
  deliveryDate: string | null
  activationStatus: string | null
  activationDate: string | null
  deliveryTrail: DeliveryTrailEntry[]
  activationTrail: ActivationTrailEntry[]
  watermark: Watermark
}

// 404 when the dispatch has no row in the analytics projection, mirroring
// getBatchJourney: "no such dispatch" and "a dispatch at stage zero" must not
// render the same.
export function getDispatchDetail(c: Client, asgnId: string) {
  return c.request<DispatchDetailView>({
    method: 'GET',
    path: `/ops/reports/dispatch/${encodeURIComponent(asgnId)}`,
  })
}

// D-24 (T6.6): the damage cases. A case IS the replacement assignment: the
// complaint overlay lives on the replacement row, which is why every field here
// describes a replacement and `replacementOf` points back at what it replaces.
export interface DamageCaseView {
  asgnId: string
  replacementOf: string
  merchantDisplayName: string
  bankReferenceCode: string
  branchCode: string | null
  damageReason: string | null
  /** What the BANK wrote on the damage row. */
  bankRemarks: string | null
  /** What an OPERATOR wrote about the case. Different people's words. */
  opsRemarks: string | null
  caseStatus: string | null
  billable: boolean
  demandState: string
  createdAt: string
  updatedAt: string
}

export function getDamageCases(c: Client, includeClosed = true) {
  return c.request<DamageCaseView[]>({
    method: 'GET',
    path: `/ops/damage-cases${includeClosed ? '?includeClosed=true' : ''}`,
  })
}

// D-26/D-27/D-28 (damage workflow, B7): the operator flags a specific
// dispatch leg as damaged, straight from the dispatch page. The confirmed
// ops-edge contract (DAMAGE_PLAN.md section 4): POST
// /ops/records/:asgnId/flag-damage, op ops:flag-damage, Idempotency-Key
// required, body { reasonCode, remarks, standeeCount?, stickerCount? }.
// reasonCode is a damage_reason master CODE (validated active server-side,
// DP-5); remarks is required, trimmed non-empty, max 500. The counts belong
// to a COLLATERAL leg only (ints 0..99, total at least 1); a SOUNDBOX leg
// takes NO counts because its replacement quantity is fixed at one (D-27).
// 201 { childAsgnId, caseStatus: 'Open' }; 404 unknown asgn; 409 while a
// live (non-Closed) case already exists for the dispatch (DP-3).
export interface FlagDamageBody {
  reasonCode: string
  remarks: string
  standeeCount?: number
  stickerCount?: number
}

export function flagDamage(c: Client, asgnId: string, body: FlagDamageBody, idempotencyKey: string) {
  return c.request<{ childAsgnId: string; caseStatus: string }>({
    method: 'POST',
    path: `/ops/records/${encodeURIComponent(asgnId)}/flag-damage`,
    body,
    idempotencyKey,
  })
}

/**
 * services/tms/src/ops-read.ts VpaDispatchRow (DAMAGE_PLAN.md section 4,
 * copied field for field): every dispatch leg carrying the searched UPI ID,
 * newest first. The tms side only (DP-6): identity, groups, counts,
 * billable, the parent link, case and demand state, activation status. The
 * courier branch lives on the per-dispatch page each row links to.
 */
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
  activationStatus: string | null
  activatedAt: string | null
  createdAt: string
}

// D-26: find the dispatches behind a customer complaint by the one thing the
// caller can read out, the UPI ID. Guard-only read; the edge matches on
// LOWER(TRIM(vpa_value)) and answers { rows }, unwrapped here so callers get
// the list itself. 400 when vpa is blank, so callers should not send one.
export async function searchDispatchesByVpa(c: Client, vpa: string): Promise<VpaDispatchRow[]> {
  const res = await c.request<{ rows: VpaDispatchRow[] }>({
    method: 'GET',
    path: `/ops/dispatches/by-vpa?vpa=${encodeURIComponent(vpa)}`,
  })
  return res.rows
}

// D-31: the damage-case counts by status, for the dashboard tile and the
// case screen's chips. A TMS ops-read, deliberately NOT analytics: case
// status is never projected into analytics (DP-7), so tms is the only
// context that can answer this honestly.
export function getDamageCaseSummary(c: Client) {
  return c.request<{ open: number; inProgress: number; closed: number }>({
    method: 'GET',
    path: '/ops/damage-cases/summary',
  })
}

// The status vocabulary is normalized server-side on whitespace and case, so
// either spelling of the middle state is accepted. Omitting opsRemarks LEAVES
// an existing note alone; sending an empty string clears it.
export function updateDamageCaseStatus(
  c: Client,
  asgnId: string,
  status: string,
  idempotencyKey: string,
  opsRemarks?: string,
) {
  return c.request<{ deduped: boolean }>({
    method: 'POST',
    path: `/ops/records/${encodeURIComponent(asgnId)}/damage-case-status`,
    body: opsRemarks === undefined ? { status } : { status, opsRemarks },
    idempotencyKey,
  })
}

// D-19 (T5.5): the CWD's activation file. Rows name DEVICES; the edge resolves
// each serial to its dispatch and runs the same per-row activation, so the
// result carries both ids and a per-row reason.
export interface ActivationUploadResult {
  activated: number
  invalid: number
  invalidRows: { rowNo: number; errors: string[] }[]
  results: { deviceId: string; dispatchId: string; activated: boolean; reason: string | null }[]
}

export function commitActivationFile(c: Client, file: File, idempotencyKey: string): Promise<ActivationUploadResult> {
  return postFile<ActivationUploadResult>(c, '/ops/uploads/activation', file, idempotencyKey)
}

// D-19 (T5.4): mark several dispatches activated in one action. The result is
// PER ROW, deliberately: the recorded objection to a Mark-all was that a
// client-side loop failing halfway leaves an operator unable to tell which
// records went through, and a per-row result is the answer to it.
export function markActivatedBulk(c: Client, dispatchIds: string[], idempotencyKey: string) {
  return c.request<{ results: { dispatchId: string; activated: boolean; reason: string | null }[] }>({
    method: 'POST',
    path: '/ops/assignments/activate-bulk',
    body: { dispatchIds },
    idempotencyKey,
  })
}

// D-16 (T4.1b): record that the activation request for these dispatch ids has
// gone out to the CWD. A list, because that is how a send happens.
export function requestActivation(c: Client, dispatchIds: string[], idempotencyKey: string) {
  return c.request<{ deduped: boolean; recorded: string[]; unknown: string[] }>({
    method: 'POST',
    path: '/ops/assignments/request-activation',
    body: { dispatchIds },
    idempotencyKey,
  })
}

export function getBatchJourney(c: Client, btchId: string) {
  return c.request<BatchJourneyView>({
    method: 'GET',
    path: `/ops/reports/batch-journey/${encodeURIComponent(btchId)}`,
  })
}
