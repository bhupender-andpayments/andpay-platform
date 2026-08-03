import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { HistoryPage } from '../../src/features/history/HistoryPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The confirmed vendor-edge contract (task 10, grounded against
// services/fulfillment/src/vendor-reads.ts readVendorHistory):
//   GET /vendor/history -> HistoryRow[]. vndr scope comes from the
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

const HISTORY_ROWS = [
  { btchId: 'btch_1', awb: 'AWB-1', shptStatus: 'DELIVERED', dispatchDate: '2026-08-01T00:00:00.000Z', deviceSerial: 'SN-1' },
  { btchId: 'btch_2', awb: 'AWB-2', shptStatus: 'IN_TRANSIT', dispatchDate: '2026-08-02T00:00:00.000Z', deviceSerial: null },
]

describe('HistoryPage', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders history rows fetched from GET /vendor/history with a Bearer header and no vndr in the request', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/vendor/history')) return jsonResponse(HISTORY_ROWS)
        return jsonResponse([])
      }),
    )

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <HistoryPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('AWB-1')).toBeTruthy()
    expect(screen.getByText('AWB-2')).toBeTruthy()
    expect(screen.getByText('DELIVERED')).toBeTruthy()
    expect(screen.getByText('IN_TRANSIT')).toBeTruthy()
    expect(screen.getByText('SN-1')).toBeTruthy()
    // The null deviceSerial row renders as a dash, never the literal "null".
    expect(screen.queryByText('null')).toBeNull()
    expect(screen.getByText('-')).toBeTruthy()

    const call = calls.find((c) => c.url.includes('/vendor/history'))
    expect(call).toBeTruthy()
    expect(headerValue(call!, 'Authorization')).toBe('Bearer tok-1')
    expect(call!.url).not.toContain('vndr')
    expect(call!.init.body === undefined || !JSON.stringify(call!.init.body).includes('vndr')).toBe(true)
  })

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null, 500)))

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <HistoryPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
