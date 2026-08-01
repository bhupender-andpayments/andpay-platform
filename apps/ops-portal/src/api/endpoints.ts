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
