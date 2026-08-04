import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { TilesPage } from '../../src/features/dashboards/TilesPage.js'
import { ReportPage } from '../../src/features/dashboards/ReportPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The confirmed edge contract (apps/ops-edge/src/reports.controller.ts +
// services/analytics/src/mediation.ts): GET /ops/reports/tiles returns
// { tiles: TileSet, watermark }, GET /ops/reports/:name and
// GET /ops/reports/tiles/:tile return { rows, watermark }. D100: the
// watermark rides the JSON body, never a header the client cannot read.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('TilesPage', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  // Demo skin (Task 12): the ACTIVATION-EMPTY masking is dropped because the
  // demo seed carries a real activation write, so every tile renders its real
  // value (including the two activation tiles) and each value may appear both
  // in a KPI card and in the lifecycle rail.
  it('renders the seven tiles with their real values (no masking) and a freshness marker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          tiles: {
            requestsReceived: 5,
            pendingQrAwaitingBatch: { count: 2, oldestAgeDays: 1.5 },
            pendingPrintVendorPickup: 3,
            dispatchedNotDelivered: 4,
            deliveredNotActivated: 9,
            damagedReplacementOpen: 1,
            activatedSuccessfully: 7,
          },
          watermark: { asOf: '2026-07-29T12:00:00.000Z', perTopic: {} },
        }),
      ),
    )

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <TilesPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    // Every tile value renders (>= once; a value may also appear in the rail).
    for (const value of ['5', '2', '3', '4', '9', '1', '7']) {
      expect((await screen.findAllByText(value)).length).toBeGreaterThanOrEqual(1)
    }
    // The activation values are now shown, never masked.
    expect(screen.queryByText(/not available/i)).toBeNull()
    // The freshness marker reflects the body's watermark.asOf.
    expect(screen.getByText(/updated/i)).toBeTruthy()
  })
})

describe('ReportPage', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('renders report rows and the freshness marker from the response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          rows: [
            {
              dispatchId: 'asgn_1',
              programId: 'p1',
              bankCode: 'HDFC',
              merchantDisplay: 'Acme',
              awb: 'AWB1',
              dispatchDate: '2026-07-01T00:00:00.000Z',
              courierStatus: 'IN_TRANSIT',
              deliveryDate: null,
            },
          ],
          watermark: { asOf: '2026-07-29T12:00:00.000Z', perTopic: {} },
        }),
      ),
    )

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <ReportPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('asgn_1')).toBeTruthy()
    expect(screen.getByText('HDFC')).toBeTruthy()
    expect(screen.getByText(/updated/i)).toBeTruthy()
  })

  it('CSV export requests format=csv via the text path and triggers a Blob download', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        if (url.includes('format=csv')) {
          return new Response('dispatchId,bankCode\r\nasgn_1,HDFC', {
            status: 200,
            headers: { 'content-type': 'text/csv; charset=utf-8' },
          })
        }
        return jsonResponse({ rows: [], watermark: { asOf: null, perTopic: {} } })
      }),
    )

    // jsdom does not implement Blob URLs at all (no pre-existing property for
    // vi.spyOn to wrap), so these are defined directly rather than spied on.
    const createObjectURL = vi.fn(() => 'blob:mock-url')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true, configurable: true })

    const clickMock = vi.fn()
    const realCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreateElement(tag)
      if (tag === 'a') (el as HTMLAnchorElement).click = clickMock
      return el
    }) as typeof document.createElement)

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <ReportPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    await screen.findByRole('button', { name: /export/i })
    await userEvent.click(screen.getByRole('button', { name: /export/i }))

    expect(urls.some((u) => u.includes('format=csv'))).toBe(true)
    expect(createObjectURL).toHaveBeenCalled()
    expect(clickMock).toHaveBeenCalled()
  })
})
