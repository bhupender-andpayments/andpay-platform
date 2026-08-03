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

export function packageDownloadPath(btchId: string): string {
  return `/vendor/batch/${encodeURIComponent(btchId)}/package`
}
