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

export function resolveQuarantine(c: Client, id: string, correctedRow: BankRequestRow, idempotencyKey: string) {
  return c.request<{ deduped: boolean; outcome: string | null }>({
    method: 'POST',
    path: `/ops/quarantine/${id}/resolve`,
    body: { correctedRow },
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
  // NO `status`. It was declared here and the server stopped sending it: the
  // 2026-08-10 ruling dropped batch.status ("derive a batch's state from its
  // children, never store a second copy") and corrected
  // services/fulfillment/src/ops-read.ts, whose BatchRow projects no such column.
  // This copy outlived it and made RecentBatches render an empty pill in the real
  // app. Do not add a stage or status here without a read that can answer it.
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
  shipToSuperseded: boolean
  // Task 6 (2026-08-11 dispatch-group split): NULL is a legacy, pre-split
  // combined row; 'SOUNDBOX' / 'COLLATERAL' otherwise. See
  // services/fulfillment/src/package.ts excelLinesFor for what this decides.
  dispatchGroup: string | null
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
}

/** services/fulfillment/src/ops-read.ts BatchArtifactRow. */
export interface BatchArtifactRow {
  asgnId: string
  artifactType: string
  assetReference: string
  supersededAt: string | null
}

/** services/fulfillment/src/ops-read.ts BatchDetailView. */
export interface BatchDetailView {
  batch: BatchRow
  entries: BatchEntryRow[]
  artifacts: BatchArtifactRow[]
  // W-6 (Task 14): the BOUND print vendor's press layout, ONE_PER_PAGE or
  // GRID_3X2, defaulting to ONE_PER_PAGE when the batch has no bound vendor.
  printLayout: string
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
  productType: string
  manufacturerVndr: string | null
  batch: string | null
  shipment: string | null
  printedForMerchant: string | null
  asgnId: string | null
  location: string | null
  createdAt: string
  updatedAt: string
}

// The device inventory. No ICCID and no manufacturer QR payload: both are
// excluded by the GRANT rather than by this shape, so the wire cannot widen
// without a migration.
export function getDevices(c: Client, status?: string) {
  const q = status !== undefined && status !== '' ? `?status=${encodeURIComponent(status)}` : ''
  return c.request<UnitInventoryRow[]>({ method: 'GET', path: `/ops/devices${q}` })
}

export function getDispatches(c: Client, status?: string) {
  const q = status !== undefined && status !== '' ? `?status=${encodeURIComponent(status)}` : ''
  return c.request<DispatchRow[]>({ method: 'GET', path: `/ops/dispatches${q}` })
}

// -----------------------------------------------------------------------
// Bank masters, damage-reason master, batching config (Phase 7 Task 8). The
// confirmed ops-edge contract (apps/ops-edge/src/ops-read.controller.ts's
// bankMasters/damageReasons/batchingConfig, grounded against
// services/identity/src/ops.ts listBankMasters/BankMasterRow,
// services/tms/src/damage-reason.ts DamageReasonRow, and
// services/fulfillment/src/ops-read.ts listBatchingConfigs/BatchingConfigRow):
// all three are the SAME class-3 guard-only posture as GET /ops/vendors above
// (no per-op D2 authorize, no 6e; check 3). READ-ONLY here: bank-master
// create/edit, damage-reason create/activate/deactivate, and the
// admin/super_admin-only batching-config SET (#24 in B_edge_contracts) are
// FR-11-deferred (L9), not built by this task. `GET /ops/bank-config` (the
// separate bank/branch COMPOSITION config, i.e. logo/branding) is a distinct
// route this task does not surface; the brief's read-surface list names
// bank-masters, not bank-config.
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
}

export function getBankMasters(c: Client) {
  return c.request<BankMasterRow[]>({ method: 'GET', path: '/ops/bank-masters' })
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
  scope: 'GLOBAL' | 'TENANT' | 'TENANT_PROGRAM'
  tenantWire: string | null
  programWire: string | null
  minLotSize: number
  maxWaitSeconds: number
  createdAt: string
  updatedAt: string
}

export function getBatchingConfig(c: Client) {
  return c.request<BatchingConfigRow[]>({ method: 'GET', path: '/ops/batching-config' })
}

// -----------------------------------------------------------------------
// Bank and damage uploads (Phase 2 Task 4; damage preview added Phase 7 Task
// 7, L11/FR08-3). The confirmed ops-edge contract
// (apps/ops-edge/src/ops.controller.ts's previewBank/commitBank/
// previewDamage/commitDamage, grounded against services/tms/src/ops.ts and
// bank-file-adapter.ts): the upload surface is MULTIPART raw-file routes
// with server-side parsing (D-K); no client-side parsing of the picked file
// remains authoritative.
//   POST /ops/uploads/bank/preview     multipart `file`, no Idempotency-Key,
//     writes nothing -> BankPreviewResult { rows, summary, structuralErrors }
//   POST /ops/uploads/bank/commit      multipart `file`, Idempotency-Key
//     -> { accepted, quarantined, duplicate, qrMalformed, fileId }
//   POST /ops/uploads/damage/preview   multipart `file`, no Idempotency-Key,
//     writes nothing -> DamagePreviewResult { rows, summary, structuralErrors }
//   POST /ops/uploads/damage/commit    multipart `file`, Idempotency-Key
//     -> { replaced, quarantined, duplicate, fileId }
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

export interface DamageCommitResult {
  replaced: number
  quarantined: number
  duplicate: number
  fileId: string
}

/** services/tms/src/damage.ts BankDamageRow (the decoded row shape a damage preview/commit carries). */
export interface BankDamageRow {
  fileId: string
  rowNo: number
  tenantReference: string
  vpaValue: string
  damageReason: string
  bankRemarks: string
  shipToAddress: string
  items?: { soundbox: boolean; standeeCount: number; stickerCount: number }
  deliveryStatus?: string
}

/**
 * Phase 7 Task 7 (L11, FR08-3 decision item 11): services/tms/src/ops.ts
 * DamagePreviewRowResult / DamagePreviewResult, the preview-parity
 * counterpart to BankPreviewResult above. `reasonCode` is present only when
 * `valid` is false: a matched row with a recognized damage reason has no
 * reason code (mirrors bank preview's `errors: []` on a valid row).
 */
export type DamagePreviewReasonCode = 'no_match' | 'ambiguous_match' | 'invalid_damage_reason' | 'ambiguous_damage_reason'

export interface DamagePreviewRowResult {
  rowNo: number
  valid: boolean
  reasonCode?: DamagePreviewReasonCode
  row: BankDamageRow
}

export interface DamagePreviewResult {
  rows: DamagePreviewRowResult[]
  summary: { total: number; valid: number; invalid: number }
  structuralErrors: StructuralParseError[]
}

// -----------------------------------------------------------------------
// Device-inventory upload (Phase 7 Task 7; edge built Phase-5 Task 1, D-G,
// FR-01a). The confirmed ops-edge contract (apps/ops-edge/src/ops.controller.ts's
// uploadDeviceInventory, grounded against services/fulfillment/src/ops-device-inventory.ts):
//   POST /ops/uploads/device-inventory   multipart `file` + a `manufacturerVndrId`
//     form field, Idempotency-Key required -> OpsDeviceInventoryResult
// FR-01a mandates ALL THREE sheet columns (Device ID, SIM No, Device QR) be
// present on every row; a row missing any of them is reported per-row here
// (invalidRows) and never ingested, WITHOUT failing the whole file.
// manufacturerVndrId is a WIRE vndr id (B_edge_contracts.md item 4), the SAME
// shape GET /ops/vendors emits, so the SPA sources it from getVendors filtered
// to type === 'MANUFACTURER' (never a raw uuid, never hand-typed).
// -----------------------------------------------------------------------

/**
 * services/fulfillment/src/device-inventory-adapter.ts DeviceInventoryRowErrorCode.
 * The `malformed_*` pair is A-2/D12's deliberately loose format check; the
 * screen needs no label map for them because StatusPill humanises the code.
 */
export type DeviceInventoryRowErrorCode =
  | 'missing_device_id'
  | 'missing_sim_no'
  | 'missing_device_qr'
  | 'malformed_device_id'
  | 'malformed_sim_no'

export interface DeviceInventoryRowError {
  rowNo: number
  errors: DeviceInventoryRowErrorCode[]
}

/** services/fulfillment/src/ops-device-inventory.ts OpsDeviceInventoryResult. */
export interface DeviceInventoryUploadResult {
  fileId: string
  accepted: number
  flagged: number
  invalid: number
  createdUnitIds: string[]
  invalidRows: DeviceInventoryRowError[]
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

// The 5 MB multipart cap the ops-edge FileInterceptor enforces
// (apps/ops-edge/src/deps.ts MAX_UPLOAD_BYTES). Checked client-side against
// File.size BEFORE any network call, so an oversized file never posts.
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

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

export function previewDamage(c: Client, file: File): Promise<DamagePreviewResult> {
  return postFile<DamagePreviewResult>(c, '/ops/uploads/damage/preview', file)
}

export function commitDamage(c: Client, file: File, idempotencyKey: string): Promise<DamageCommitResult> {
  return postFile<DamageCommitResult>(c, '/ops/uploads/damage/commit', file, idempotencyKey)
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
export function holdRecord(c: Client, asgnId: string, idempotencyKey: string) {
  return c.request<{ deduped: boolean }>({
    method: 'POST',
    path: `/ops/records/${asgnId}/hold`,
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
  return { blob, filename: filenameFromContentDisposition(res, `dispatch-${group}-${btchId}.xlsx`) }
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
  return { blob, filename: filenameFromContentDisposition(res, `${artifactType}-${btchId}.pdf`) }
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
export function getBatchJourney(c: Client, btchId: string) {
  return c.request<BatchJourneyView>({
    method: 'GET',
    path: `/ops/reports/batch-journey/${encodeURIComponent(btchId)}`,
  })
}
