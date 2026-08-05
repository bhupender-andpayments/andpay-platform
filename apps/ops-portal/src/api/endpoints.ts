import type { ApiRequest } from './client.js'
import { getAccessToken } from './tokenStore.js'
import { ApiError } from './errors.js'

type Client = { request<T>(req: ApiRequest): Promise<T> }

// The real /session/login contract (apps/auth-edge/src/login.controller.ts):
// body is { handle, password, totp } and the response is ONLY { accessToken }.
// There is no principal object on the wire; the caller derives a display
// principal by decoding the token itself (see AuthContext.decodeTokenClaims).
export function login(c: Client, body: { handle: string; password: string; totp: string }) {
  return c.request<{ accessToken: string }>({
    method: 'POST',
    path: '/session/login',
    base: 'auth',
    withCookie: true,
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

/** The seven FR-09 dashboard tiles (services/analytics/src/mediation.ts TileSet). */
export interface TileSet {
  requestsReceived: number
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
// specific ingest file/row), unlike the brief's flattened summary.
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

// G-SHPT (docs/plan/phase7_grounding/B_edge_contracts.md gap 2): body.shptId
// must be a WIRE shpt id (the domain op `toUuid`s it), but no ops-edge read
// exposes one for this queue. GET /ops/exceptions/status emits `subjectRef`,
// an opaque courier-side reference string, not a `shpt_` wire id; the only
// other shpt-shaped value anywhere is the analytics report rail's projected
// `shptId`, whose wire-ness the grounding doc explicitly flags UNVERIFIED for
// this purpose. This function still mirrors the real edge contract 1:1 (kept
// for when G-SHPT is resolved with a real read), but QueuesPage.tsx does NOT
// call it: the status-exception resolve control is gated (disabled, with an
// explanatory note) rather than sending a subjectRef or a raw exception id in
// place of a wire shptId.
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
//     -> { accepted, quarantined, duplicate, fileId }
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

/** services/tms/src/ingest.ts RequestRowRejectReason. */
export type RequestRowRejectReason = 'invalid_qr_vpa_format' | 'missing_recipient_contact'

/** services/tms/src/ops.ts PreviewRowResult: one row's preview verdict. */
export interface PreviewRowResult {
  rowNo: number
  valid: boolean
  errors: RequestRowRejectReason[]
  row: BankRequestRow
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

/** services/fulfillment/src/device-inventory-adapter.ts DeviceInventoryRowErrorCode. */
export type DeviceInventoryRowErrorCode = 'missing_device_id' | 'missing_sim_no' | 'missing_device_qr'

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

// The 5 MiB multipart cap the ops-edge FileInterceptor enforces
// (apps/ops-edge/src/deps.ts MAX_UPLOAD_BYTES). Checked client-side against
// File.size BEFORE any network call, so an oversized file never posts.
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

function opsBaseUrl(): string {
  return (import.meta.env.VITE_OPS_BASE as string | undefined) ?? 'http://localhost:3001'
}

// The shared raw multipart POST (mirrors ReturnUploadPage's fetch): a
// FormData `file` part, an optional set of additional plain-string form
// fields (device-inventory's `manufacturerVndrId`), a Bearer header read
// straight off tokenStore (never the JSON client, which always sets
// Content-Type: application/json), and an optional Idempotency-Key header
// for the commit routes (a preview route never sends one; it is a pure
// read).
async function postFile<T>(
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
  const headers: Record<string, string> = { Authorization: `Bearer ${getAccessToken()}` }
  if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey
  const res = await fetch(`${opsBaseUrl()}${path}`, { method: 'POST', headers, body: form })
  const text = await res.text()
  if (!res.ok) {
    throw new ApiError(res.status, text === '' ? null : JSON.parse(text))
  }
  return (text === '' ? null : JSON.parse(text)) as T
}

export function previewBank(file: File): Promise<BankPreviewResult> {
  return postFile<BankPreviewResult>('/ops/uploads/bank/preview', file)
}

export function commitBank(file: File, idempotencyKey: string): Promise<BankCommitResult> {
  return postFile<BankCommitResult>('/ops/uploads/bank/commit', file, idempotencyKey)
}

export function previewDamage(file: File): Promise<DamagePreviewResult> {
  return postFile<DamagePreviewResult>('/ops/uploads/damage/preview', file)
}

export function commitDamage(file: File, idempotencyKey: string): Promise<DamageCommitResult> {
  return postFile<DamageCommitResult>('/ops/uploads/damage/commit', file, idempotencyKey)
}

export function commitDeviceInventory(
  file: File,
  manufacturerVndrId: string,
  idempotencyKey: string,
): Promise<DeviceInventoryUploadResult> {
  return postFile<DeviceInventoryUploadResult>('/ops/uploads/device-inventory', file, idempotencyKey, {
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
