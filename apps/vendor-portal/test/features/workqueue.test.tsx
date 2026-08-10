import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { WorkQueuePage } from '../../src/features/workqueue/WorkQueuePage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The confirmed vendor-edge contract (task 10, grounded against
// services/fulfillment/src/vendor-reads.ts readVendorWorkQueue):
//   GET /vendor/work-queue -> WorkQueueRow[]. vndr scope comes from the
// authenticated principal (never a request param), so the request must
// carry no `vndr` anywhere in its URL or body.

interface Call {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function headerValue(call: Call, name: string): string | null {
  const headers = call.init.headers as Record<string, string>
  return headers[name] ?? null
}

const WORK_QUEUE_ROWS = [
  { btchId: 'btch_1', unitCount: 10, openEntries: 3, createdAt: '2026-08-01T00:00:00.000Z' },
  { btchId: 'btch_2', unitCount: 5, openEntries: 0, createdAt: '2026-08-02T00:00:00.000Z' },
]

describe('WorkQueuePage', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders work-queue rows fetched from GET /vendor/work-queue with a Bearer header and no vndr in the request', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/vendor/work-queue')) return jsonResponse(WORK_QUEUE_ROWS)
        return jsonResponse([])
      }),
    )

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <WorkQueuePage />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('btch_1')).toBeTruthy()
    expect(screen.getByText('btch_2')).toBeTruthy()
    // The Status column is gone with batch.status (2026-08-10 ruling: derive a
    // batch's state from its children). Open entries against units is what the
    // vendor needs, and unlike the old write-once 'BORN' it cannot go stale.
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.queryByText('Status')).toBeNull()

    const call = calls.find((c) => c.url.includes('/vendor/work-queue'))
    expect(call).toBeTruthy()
    expect(headerValue(call!, 'Authorization')).toBe('Bearer tok-1')
    expect(call!.url).not.toContain('vndr')
    expect(call!.init.body === undefined || !JSON.stringify(call!.init.body).includes('vndr')).toBe(true)

    // Task 15: a DownloadPackageButton (task 13) renders per row, one per
    // batch, taking only btchId (no PII column added). 2026-08-10 ruling: the
    // pull is per delivery group, so each row now carries TWO buttons, one for
    // Soundbox and one for Collateral.
    expect(screen.getAllByRole('button', { name: /download soundbox excel/i })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /download collateral excel/i })).toHaveLength(2)
  })

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null, 500)))

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <WorkQueuePage />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
