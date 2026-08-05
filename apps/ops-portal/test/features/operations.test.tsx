import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { OperationsPage } from '../../src/features/operations/OperationsPage.js'
import { BatchPage } from '../../src/features/operations/BatchPage.js'
import { StatusCorrectionForm } from '../../src/features/operations/StatusCorrectionForm.js'
import { RecomposeForm } from '../../src/features/operations/RecomposeForm.js'
import { HoldButton } from '../../src/features/operations/HoldButton.js'
import { DispatchHistoryPage } from '../../src/features/operations/DispatchHistoryPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The confirmed ops-edge contract (Phase 7 Task 9 brief, grounded against
// apps/ops-edge/src/ops.controller.ts, apps/ops-edge/src/ops-read.controller.ts):
//   POST /ops/batches/trigger                          { tenantWire, programWire } -> { btchId } | null
//   POST /ops/shipments/:id/correct                     { status, courierTimestamp } -> { deduped, outcome }
//   POST /ops/artifacts/recompose                       { asgnId, artifactType, requestedShipTo? } -> { deduped, artifactId }
//   POST /ops/records/:asgnId/hold                      (no body) -> { deduped }
//   GET  /ops/batches/:btchId/dispatch-excel             -> binary xlsx
//   GET  /ops/batches/:btchId/collateral/:artifactType   -> binary pdf | 404
// None of the four writes are step-up-gated. Dispatch history reuses
// getReport('soundbox-delivery', filters); the G-SHPT backend slice (commit
// 354aa76) added a real wire shptId column to that report's rows
// (services/analytics/src/mediation.ts soundboxDeliveryRow), so
// StatusCorrectionForm is now driven ONLY by a shptId picked from a real
// dispatch-history row - never a hand-typed value.

interface Call {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function parseBody(call: Call): Record<string, unknown> {
  return call.init.body === undefined ? {} : (JSON.parse(call.init.body as string) as Record<string, unknown>)
}

function headerValue(call: Call, name: string): string | null {
  const headers = call.init.headers as Record<string, string>
  return headers[name] ?? null
}

function withProviders(children: React.ReactNode) {
  return (
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>{children}</AuthProvider>
    </MemoryRouter>
  )
}

describe('OperationsPage', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders the Operations heading and all six tabs', () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})))
    render(withProviders(<OperationsPage />))
    expect(screen.getByRole('heading', { name: /operations/i })).toBeTruthy()
    for (const label of ['Batch', 'Status Correction', 'Recompose', 'Hold', 'Dispatch History', 'Destructive']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
  })
})

describe('BatchPage', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('triggers a batch, posting { tenantWire, programWire } with an Idempotency-Key, and renders the btchId', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/batches/trigger')) return jsonResponse({ btchId: 'btch_abc123' })
        return jsonResponse({})
      }),
    )

    render(withProviders(<BatchPage />))

    await userEvent.type(screen.getByLabelText(/tenant/i), 'ten_1')
    await userEvent.type(screen.getByLabelText(/program/i), 'prg_1')
    await userEvent.click(screen.getByRole('button', { name: /trigger/i }))

    expect(await screen.findByText(/btch_abc123/)).toBeTruthy()

    const call = calls.find((c) => c.url.includes('/ops/batches/trigger'))
    expect(call).toBeTruthy()
    expect(call!.init.method).toBe('POST')
    expect(headerValue(call!, 'Idempotency-Key')).toBeTruthy()
    const body = parseBody(call!)
    expect(body.tenantWire).toBe('ten_1')
    expect(body.programWire).toBe('prg_1')
  })

  it('renders a clear "nothing to batch" message when the response is null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)))

    render(withProviders(<BatchPage />))

    await userEvent.type(screen.getByLabelText(/tenant/i), 'ten_1')
    await userEvent.type(screen.getByLabelText(/program/i), 'prg_1')
    await userEvent.click(screen.getByRole('button', { name: /trigger/i }))

    expect(await screen.findByText(/nothing to batch/i)).toBeTruthy()
  })

  it('downloads the dispatch sheet for a typed batch id, hitting GET /ops/batches/:btchId/dispatch-excel with a Bearer token, and saves the exact served bytes', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/dispatch-excel')) {
          return new Response('xlsx-bytes', {
            status: 200,
            headers: {
              'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'content-disposition': 'attachment; filename="dispatch-btch_1.xlsx"',
            },
          })
        }
        return jsonResponse({})
      }),
    )

    const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock-url')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true, configurable: true })
    const realCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreateElement(tag)
      if (tag === 'a') (el as HTMLAnchorElement).click = vi.fn()
      return el
    }) as typeof document.createElement)

    render(withProviders(<BatchPage />))

    await userEvent.type(screen.getByLabelText(/batch id/i), 'btch_1')
    await userEvent.click(screen.getByRole('button', { name: /download dispatch sheet/i }))

    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/batches/btch_1/dispatch-excel'))).toBe(true)
    })
    const call = calls.find((c) => c.url.includes('/ops/batches/btch_1/dispatch-excel'))!
    expect(call.init.method === undefined || call.init.method === 'GET').toBe(true)
    const headers = call.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-1')

    await vi.waitFor(() => {
      expect(createObjectURL).toHaveBeenCalled()
    })
    // jsdom's Blob polyfill exposes only size/type (no async text()/arrayBuffer()),
    // so size + content-type are the available proof the exact served bytes
    // (not a re-derived or fabricated rendering of them) reached the download,
    // matching exportCsv.test's own jsdom-limitation workaround.
    const savedBlob = createObjectURL.mock.calls[0]![0]
    expect(savedBlob.size).toBe('xlsx-bytes'.length)
    expect(savedBlob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })

  it('downloads collateral for a typed batch id + artifact type, hitting GET /ops/batches/:btchId/collateral/:artifactType', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/collateral/')) {
          return new Response('pdf-bytes', {
            status: 200,
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': 'attachment; filename="SOUNDBOX_IMG-btch_2.pdf"',
            },
          })
        }
        return jsonResponse({})
      }),
    )
    const createObjectURL = vi.fn(() => 'blob:mock-url')
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true, configurable: true })
    const realCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreateElement(tag)
      if (tag === 'a') (el as HTMLAnchorElement).click = vi.fn()
      return el
    }) as typeof document.createElement)

    render(withProviders(<BatchPage />))

    await userEvent.type(screen.getByLabelText(/batch id/i), 'btch_2')
    await userEvent.selectOptions(screen.getByLabelText(/collateral type/i), 'SOUNDBOX_IMG')
    await userEvent.click(screen.getByRole('button', { name: /download collateral/i }))

    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/batches/btch_2/collateral/SOUNDBOX_IMG'))).toBe(true)
    })
    await vi.waitFor(() => {
      expect(createObjectURL).toHaveBeenCalled()
    })
  })

  it('shows a not-found note (not an error) when the collateral route 404s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/collateral/')) return new Response(null, { status: 404 })
        return jsonResponse({})
      }),
    )

    render(withProviders(<BatchPage />))

    await userEvent.type(screen.getByLabelText(/batch id/i), 'btch_3')
    await userEvent.click(screen.getByRole('button', { name: /download collateral/i }))

    expect(await screen.findByText(/no .*collateral/i)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('StatusCorrectionForm (G-SHPT: driven only by a selected dispatch-history row)', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('with no row selected: shows a guidance note, renders no shipment-id input of any kind, and cannot submit', () => {
    render(withProviders(<StatusCorrectionForm selectedRow={null} />))

    expect(screen.getByText(/select a shipment/i)).toBeTruthy()
    expect(screen.queryByLabelText(/shipment/i)).toBeNull()
    expect(screen.queryByRole('textbox', { name: /shipment/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /submit correction/i })).toBeNull()
  })

  it('with a selected row whose shptId is null: refuses to render a correctable form (guard)', () => {
    render(withProviders(<StatusCorrectionForm selectedRow={{ dispatchId: 'asgn_1', awb: 'AWB-9', shptId: null }} />))

    expect(screen.getByText(/no verified wire shipment id/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /submit correction/i })).toBeNull()
  })

  it('with a selected row carrying a real shptId: renders it as static text (no editable input) and posts the SAME wire shptId to /ops/shipments/:id/correct', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/shipments/shpt_real1/correct')) {
          return jsonResponse({ deduped: false, outcome: 'advanced' })
        }
        return jsonResponse({})
      }),
    )

    render(
      withProviders(
        <StatusCorrectionForm selectedRow={{ dispatchId: 'asgn_1', awb: 'AWB-1', shptId: 'shpt_real1' }} />,
      ),
    )

    // The real shptId is visible as static text...
    expect(screen.getByText('shpt_real1')).toBeTruthy()
    // ...and there is no input the operator could type a different id into.
    expect(screen.queryByRole('textbox', { name: /shipment/i })).toBeNull()

    await userEvent.selectOptions(screen.getByLabelText(/status/i), 'DELIVERED')
    await userEvent.type(screen.getByLabelText(/courier timestamp/i), '2026-08-01T10:00')
    await userEvent.click(screen.getByRole('button', { name: /submit correction/i }))

    expect(await screen.findByText(/advanced/i)).toBeTruthy()

    const call = calls.find((c) => c.url.includes('/ops/shipments/'))
    expect(call).toBeTruthy()
    // Proves the WIRE shptId from the row drove the URL, never the row's
    // other identifiers (dispatchId/awb) and never a hand-typed value.
    expect(call!.url).toContain('/ops/shipments/shpt_real1/correct')
    expect(headerValue(call!, 'Idempotency-Key')).toBeTruthy()
    const body = parseBody(call!)
    expect(body.status).toBe('DELIVERED')
    expect(body.courierTimestamp).toBe('2026-08-01T10:00')
  })

  it('the status dropdown offers only the known courier statuses', () => {
    render(withProviders(<StatusCorrectionForm selectedRow={{ dispatchId: 'asgn_1', shptId: 'shpt_1' }} />))
    const select = screen.getByLabelText(/status/i) as HTMLSelectElement
    const values = Array.from(select.options).map((o) => o.value)
    expect(values).toEqual([
      'DISPATCHED_BY_VENDOR',
      'PICKED_UP',
      'IN_TRANSIT',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'FAILED',
      'RETURNED',
    ])
  })
})

describe('RecomposeForm', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('posts { asgnId, artifactType } to /ops/artifacts/recompose with an Idempotency-Key', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/artifacts/recompose')) {
          return jsonResponse({ deduped: false, artifactId: 'artf_1' })
        }
        return jsonResponse({})
      }),
    )

    render(withProviders(<RecomposeForm />))

    await userEvent.type(screen.getByLabelText(/assignment id/i), 'asgn_1')
    await userEvent.selectOptions(screen.getByLabelText(/artifact type/i), 'SOUNDBOX_IMG')
    await userEvent.click(screen.getByRole('button', { name: /recompose/i }))

    expect(await screen.findByText(/artf_1/)).toBeTruthy()

    const call = calls.find((c) => c.url.includes('/ops/artifacts/recompose'))
    expect(call).toBeTruthy()
    expect(headerValue(call!, 'Idempotency-Key')).toBeTruthy()
    const body = parseBody(call!)
    expect(body.asgnId).toBe('asgn_1')
    expect(body.artifactType).toBe('SOUNDBOX_IMG')
    expect(body.requestedShipTo).toBeUndefined()
  })

  it('includes requestedShipTo when provided', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return jsonResponse({ deduped: false, artifactId: 'artf_2' })
      }),
    )

    render(withProviders(<RecomposeForm />))

    await userEvent.type(screen.getByLabelText(/assignment id/i), 'asgn_2')
    await userEvent.selectOptions(screen.getByLabelText(/artifact type/i), 'STANDEE_IMG')
    await userEvent.type(screen.getByLabelText(/requested ship.to/i), '5 New St')
    await userEvent.click(screen.getByRole('button', { name: /recompose/i }))

    expect(await screen.findByText(/artf_2/)).toBeTruthy()
    const call = calls.find((c) => c.url.includes('/ops/artifacts/recompose'))!
    const body = parseBody(call)
    expect(body.requestedShipTo).toBe('5 New St')
  })
})

describe('HoldButton', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('posts to /ops/records/:asgnId/hold with no body, with an Idempotency-Key', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/records/asgn_9/hold')) return jsonResponse({ deduped: false })
        return jsonResponse({})
      }),
    )

    render(withProviders(<HoldButton />))

    await userEvent.type(screen.getByLabelText(/assignment id/i), 'asgn_9')
    await userEvent.click(screen.getByRole('button', { name: /hold/i }))

    expect(await screen.findByText(/hold (recorded|placed|applied)/i)).toBeTruthy()

    const call = calls.find((c) => c.url.includes('/ops/records/asgn_9/hold'))
    expect(call).toBeTruthy()
    expect(call!.init.method).toBe('POST')
    expect(headerValue(call!, 'Idempotency-Key')).toBeTruthy()
    expect(call!.init.body).toBeUndefined()
  })
})

describe('DispatchHistoryPage', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders soundbox-delivery report rows (including the new shptId column) via getReport', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return jsonResponse({
          rows: [{ dispatchId: 'asgn_1', bankCode: 'HDFC', awb: 'AWB-1', shptId: 'shpt_1' }],
          watermark: { asOf: '2026-08-01T00:00:00.000Z', perTopic: {} },
        })
      }),
    )

    render(withProviders(<DispatchHistoryPage onCorrectStatus={() => {}} />))

    expect(await screen.findByText('AWB-1')).toBeTruthy()
    expect(screen.getByText('shpt_1')).toBeTruthy()
    const call = calls.find((c) => c.url.includes('/ops/reports/soundbox-delivery'))
    expect(call).toBeTruthy()
    expect(call!.init.method).toBe('GET')
  })

  it('a row WITH a real shptId has an enabled "Correct status" action that fires onCorrectStatus with that row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          rows: [{ dispatchId: 'asgn_1', awb: 'AWB-1', shptId: 'shpt_real' }],
          watermark: { asOf: null, perTopic: {} },
        }),
      ),
    )
    const onCorrectStatus = vi.fn()
    render(withProviders(<DispatchHistoryPage onCorrectStatus={onCorrectStatus} />))

    const row = (await screen.findByText('AWB-1')).closest('tr')!
    const button = within(row).getByRole('button', { name: /correct status/i }) as HTMLButtonElement
    expect(button.disabled).toBe(false)

    await userEvent.click(button)
    expect(onCorrectStatus).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchId: 'asgn_1', shptId: 'shpt_real' }),
    )
  })

  it('a row whose shptId is null must NOT be correctable: the action is disabled and never fires', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          rows: [{ dispatchId: 'asgn_2', awb: 'AWB-2', shptId: null }],
          watermark: { asOf: null, perTopic: {} },
        }),
      ),
    )
    const onCorrectStatus = vi.fn()
    render(withProviders(<DispatchHistoryPage onCorrectStatus={onCorrectStatus} />))

    const row = (await screen.findByText('AWB-2')).closest('tr')!
    const button = within(row).getByRole('button', { name: /correct status/i }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    await userEvent.click(button)
    expect(onCorrectStatus).not.toHaveBeenCalled()
  })
})

describe('OperationsPage integration: selecting a dispatch-history row drives Status Correction', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('clicking Correct status on a real-shptId row switches to the Status Correction tab pre-selected with that row, and submitting sends the SAME wire shptId (not the row awb/dispatchId)', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/reports/soundbox-delivery')) {
          return jsonResponse({
            rows: [
              { dispatchId: 'asgn_1', awb: 'AWB-1', shptId: 'shpt_from_row' },
              { dispatchId: 'asgn_2', awb: 'AWB-2', shptId: null },
            ],
            watermark: { asOf: null, perTopic: {} },
          })
        }
        if (url.includes('/ops/shipments/shpt_from_row/correct')) {
          return jsonResponse({ deduped: false, outcome: 'advanced' })
        }
        return jsonResponse({})
      }),
    )

    render(withProviders(<OperationsPage />))

    await userEvent.click(screen.getByRole('button', { name: 'Dispatch History' }))
    const row = (await screen.findByText('AWB-1')).closest('tr')!
    await userEvent.click(within(row).getByRole('button', { name: /correct status/i }))

    // Now on the Status Correction tab, with the real shptId already shown.
    expect(screen.getByRole('button', { name: 'Status Correction', pressed: true })).toBeTruthy()
    expect(screen.getByText('shpt_from_row')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: /shipment/i })).toBeNull()

    await userEvent.selectOptions(screen.getByLabelText(/status/i), 'DELIVERED')
    await userEvent.type(screen.getByLabelText(/courier timestamp/i), '2026-08-01T10:00')
    await userEvent.click(screen.getByRole('button', { name: /submit correction/i }))

    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/shipments/shpt_from_row/correct'))).toBe(true)
    })
    // Never sent the row's other identifiers as the id.
    expect(calls.some((c) => c.url.includes('/ops/shipments/asgn_1/correct'))).toBe(false)
    expect(calls.some((c) => c.url.includes('/ops/shipments/AWB-1/correct'))).toBe(false)
  })

  it('a null-shptId row cannot reach Status Correction: the action is disabled on Dispatch History', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/reports/soundbox-delivery')) {
          return jsonResponse({
            rows: [{ dispatchId: 'asgn_2', awb: 'AWB-2', shptId: null }],
            watermark: { asOf: null, perTopic: {} },
          })
        }
        return jsonResponse({})
      }),
    )

    render(withProviders(<OperationsPage />))

    await userEvent.click(screen.getByRole('button', { name: 'Dispatch History' }))
    const row = (await screen.findByText('AWB-2')).closest('tr')!
    const button = within(row).getByRole('button', { name: /correct status/i }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    // Still on Dispatch History; Status Correction tab was never entered.
    expect(screen.getByRole('button', { name: 'Dispatch History', pressed: true })).toBeTruthy()
  })
})
