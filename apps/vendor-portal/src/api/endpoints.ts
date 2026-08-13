import type { createApiClient } from './client.js'
import type { WorkQueueRow, HistoryRow } from './types.js'

type Client = ReturnType<typeof createApiClient>

export function login(c: Client, body: { handle: string; password: string; totp: string }) {
  return c.request<{ accessToken: string }>({ method: 'POST', path: '/session/login', base: 'auth', withCookie: true, body })
}

export function logout(c: Client) {
  return c.request<void>({ method: 'POST', path: '/session/logout', base: 'auth', withCookie: true })
}

export function workQueue(c: Client) {
  return c.request<WorkQueueRow[]>({ method: 'GET', path: '/vendor/work-queue', base: 'vendor' })
}

export function history(c: Client) {
  return c.request<HistoryRow[]>({ method: 'GET', path: '/vendor/history', base: 'vendor' })
}

// The package pull is per DELIVERY GROUP (2026-08-10 ruling), the same
// grouping the dispatch Excel builder and the ops download already speak.
export function packageDownloadPath(btchId: string, group: 'SOUNDBOX' | 'COLLATERAL'): string {
  return `/vendor/batch/${encodeURIComponent(btchId)}/package/${group}`
}

// The IMAGE half of the same package (D-12; Q11 ruled 13 Aug 2026: four files
// per dispatch, in two pairs, a soundbox Excel plus soundbox QR images and a
// collateral Excel plus collateral QR images).
//
// This route has existed at the edge since spec 14b, with the same own-batch
// authorize and the same ALLOW/DENY 6e as the Excel pull, and nothing in this
// portal ever called it: a print vendor could reach two of their four files by
// clicking and the other two only by hand-building a URL. The buttons even said
// "Soundbox Excel" and "Collateral Excel", so the gap was known and named.
export function collateralDownloadPath(btchId: string, group: 'SOUNDBOX' | 'COLLATERAL'): string {
  return `/vendor/batch/${encodeURIComponent(btchId)}/collateral/${group}`
}
