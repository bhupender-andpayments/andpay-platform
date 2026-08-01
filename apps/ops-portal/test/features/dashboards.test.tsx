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

  it('renders the seven tiles faithfully; the two activation tiles show the empty marker, never a fabricated count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          tiles: {
            requestsReceived: 5,
            pendingQrAwaitingBatch: { count: 2, oldestAgeDays: 1.5 },
            pendingPrintVendorPickup: 3,
            dispatchedNotDelivered: 4,
            deliveredNotActivated: 9, // backend may return a number: must NOT be rendered as-is
            damagedReplacementOpen: 1,
            activatedSuccessfully: 7, // same
          },
          watermark: { asOf: '2026-07-29T12:00:00.000Z', perTopic: {} },
        }),
      ),
    )

    render(
      <MemoryRouter>
        <AuthProvider>
          <TilesPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('5')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
    // The fabricated activation counts must never appear anywhere on the page.
    expect(screen.queryByText('9')).toBeNull()
    expect(screen.queryByText('7')).toBeNull()
    // Both activation-dependent tiles show the neutral empty marker instead.
    expect(screen.getAllByText(/not available/i)).toHaveLength(2)
    // The watermark badge reflects the body's watermark.asOf, not a header.
    expect(screen.getByText(/as of 2026-07-29T12:00:00\.000Z/i)).toBeTruthy()
  })
})

describe('ReportPage', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('renders report rows and the watermark badge from the response body', async () => {
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
      <MemoryRouter>
        <AuthProvider>
          <ReportPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('asgn_1')).toBeTruthy()
    expect(screen.getByText('HDFC')).toBeTruthy()
    expect(screen.getByText(/as of 2026-07-29T12:00:00\.000Z/i)).toBeTruthy()
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
      <MemoryRouter>
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
