import type { ApiRequest } from './client.js'

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
// the spec 06a mandatory recipient contact columns (contactName, mobile) and
// the optional vpaHint the brief's flattened list omitted.
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
