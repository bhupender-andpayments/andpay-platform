import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { ReportPage } from '../../src/features/dashboards/ReportPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The confirmed FR-10 contract (apps/ops-edge/src/reports.controller.ts +
// services/analytics/src/mediation.ts): GET /ops/reports/:name returns
// { rows: ReportRow[], watermark }; ?format=csv on the same route returns
// text/csv. Every report row shape below is copied verbatim from
// mediation.ts's per-report row builders (soundboxDeliveryRow, activationRow,
// damagedReplacementRow), never invented here.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function renderReportPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <ReportPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('ReportPage', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders a report row using only the fields the mocked response actually carries (no hardcoded cell values)', async () => {
    // services/analytics/src/mediation.ts soundboxDeliveryRow shape.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          rows: [
            {
              dispatchId: 'dsp_alpha',
              programId: 'prg_1',
              bankCode: 'HDFC',
              merchantDisplay: 'Acme Traders',
              awb: 'AWB-001',
              dispatchDate: '2026-07-01T00:00:00.000Z',
              courierStatus: 'IN_TRANSIT',
              deliveryDate: null,
            },
          ],
          watermark: { asOf: '2026-07-29T12:00:00.000Z', perTopic: {} },
        }),
      ),
    )

    renderReportPage()

    // Every cell asserted below is a distinct fixture value: if the component
    // ever swapped in a hardcoded string this would fail (a different fixture
    // is used for the activation-report test below to prove the same).
    expect(await screen.findByText('dsp_alpha')).toBeTruthy()
    expect(screen.getByText('HDFC')).toBeTruthy()
    expect(screen.getByText('Acme Traders')).toBeTruthy()
    expect(screen.getByText('AWB-001')).toBeTruthy()
    expect(screen.getByText('IN_TRANSIT')).toBeTruthy()
    // The badge renders the instant in the reader's locale rather than as a raw
    // ISO string, and keeps the exact instant on the title attribute. Asserting
    // the title is both locale-independent and a tighter check than matching
    // formatted text.
    const badge = screen.getByTitle('2026-07-29T12:00:00.000Z')
    expect(badge.textContent).toMatch(/^as of /)
  })

  it('changing a filter and searching re-queries the report endpoint with the corresponding query params', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        return jsonResponse({ rows: [], watermark: { asOf: null, perTopic: {} } })
      }),
    )

    renderReportPage()
    await screen.findByRole('button', { name: /search/i })

    // Initial mount load carries no filters.
    expect(urls.some((u) => u.includes('/ops/reports/soundbox-delivery') && !u.includes('bank='))).toBe(true)

    await userEvent.type(screen.getByLabelText(/bank/i), 'HDFC')
    await userEvent.type(screen.getByLabelText(/^status/i), 'DELIVERED')
    await userEvent.click(screen.getByRole('button', { name: /search/i }))

    const requeried = urls[urls.length - 1]!
    expect(requeried).toContain('/ops/reports/soundbox-delivery')
    expect(requeried).toContain('bank=HDFC')
    expect(requeried).toContain('status=DELIVERED')
  })

  it('CSV export requests format=csv and downloads exactly the served CSV text', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        if (url.includes('format=csv')) {
          return new Response('dispatchId,bankCode\r\ndsp_alpha,HDFC', {
            status: 200,
            headers: { 'content-type': 'text/csv; charset=utf-8' },
          })
        }
        return jsonResponse({ rows: [], watermark: { asOf: null, perTopic: {} } })
      }),
    )

    // jsdom has no Blob-URL implementation to spy on; define directly. The
    // Blob constructor itself is wrapped (not just createObjectURL) so the
    // exact text handed to `new Blob([csv], ...)` in exportCsv.ts's
    // downloadCsv is captured, proving the exported content is the served CSV
    // text verbatim, not a re-derived or fabricated rendering of it.
    const createObjectURL = vi.fn(() => 'blob:mock-url')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true, configurable: true })

    const blobParts: string[] = []
    const RealBlob = globalThis.Blob
    class SpyBlob extends RealBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options)
        blobParts.push(String(parts[0]))
      }
    }
    vi.stubGlobal('Blob', SpyBlob)

    const realCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreateElement(tag)
      if (tag === 'a') (el as HTMLAnchorElement).click = vi.fn()
      return el
    }) as typeof document.createElement)

    renderReportPage()
    await screen.findByRole('button', { name: /export/i })
    await userEvent.click(screen.getByRole('button', { name: /export/i }))

    expect(urls.some((u) => u.includes('/ops/reports/soundbox-delivery') && u.includes('format=csv'))).toBe(true)
    expect(createObjectURL).toHaveBeenCalled()
    expect(blobParts).toEqual(['dispatchId,bankCode\r\ndsp_alpha,HDFC'])
  })

  it('the activation report renders its real Device ID and SIM activation status columns, with a present-but-null failure-reason cell (never fabricated)', async () => {
    // services/analytics/src/mediation.ts activationRow shape: the FR-07
    // Phase-1 delivered-not-activated worklist. activationStatus,
    // simActivationStatus, activationDate, and activationFailureReason are all
    // NULL in live v1 data (no activation write path yet, C3 fence) - the row
    // still carries the columns, just with null values, which must render as
    // present-but-empty, never as invented text.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          rows: [
            {
              dispatchId: 'dsp_activation_1',
              programId: 'prg_1',
              bankCode: 'HDFC',
              merchantDisplay: 'Acme Traders',
              deviceIds: ['dev_serial_1', 'dev_serial_2'],
              deliveryDate: '2026-07-20T00:00:00.000Z',
              activationStatus: null,
              simActivationStatus: null,
              activationDate: null,
              activationFailureReason: null,
            },
          ],
          watermark: { asOf: '2026-07-29T12:00:00.000Z', perTopic: {} },
        }),
      ),
    )

    renderReportPage()

    await userEvent.selectOptions(await screen.findByLabelText(/^report$/i), 'activation')
    await userEvent.click(screen.getByRole('button', { name: /search/i }))

    expect(await screen.findByText('dsp_activation_1')).toBeTruthy()
    // Device IDs: the real deviceIds array, joined, never a fabricated single id.
    expect(screen.getByText('dev_serial_1; dev_serial_2')).toBeTruthy()
    // The column headers for the activation-specific fields are present.
    expect(screen.getByRole('columnheader', { name: /device/i })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: /sim activation status/i })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: /activation failure reason/i })).toBeTruthy()
    // No fabricated failure-reason text ever appears (C3 fence): the column
    // exists and its cell renders as empty/present, never invented prose.
    expect(screen.queryByText(/no failure|n\/a|unknown reason|failed to activate/i)).toBeNull()
  })

  it('the damaged-replacement report renders only its real columns; no case-status lifecycle field is fabricated (C4 fence)', async () => {
    // services/analytics/src/mediation.ts damagedReplacementRow shape: no
    // case-status/lifecycle field exists on this row today (FENCED, C4).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          rows: [
            {
              dispatchId: 'dsp_dmg_1',
              programId: 'prg_1',
              bankCode: 'HDFC',
              isReplacement: false,
              originalDispatchId: null,
              damageReason: 'SCREEN_CRACKED',
              replacementDispatchId: 'dsp_dmg_2',
              replacementStatus: 'RAISED',
            },
          ],
          watermark: { asOf: '2026-07-29T12:00:00.000Z', perTopic: {} },
        }),
      ),
    )

    renderReportPage()
    await userEvent.selectOptions(await screen.findByLabelText(/^report$/i), 'damaged-replacement')
    await userEvent.click(screen.getByRole('button', { name: /search/i }))

    expect(await screen.findByText('dsp_dmg_1')).toBeTruthy()
    expect(screen.getByText('SCREEN_CRACKED')).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: /case status/i })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: /lifecycle/i })).toBeNull()
  })
})
