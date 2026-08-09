import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { OperationsPage } from '../../src/features/operations/OperationsPage.js'
import { BatchPage } from '../../src/features/operations/BatchPage.js'
import { StatusCorrectionForm } from '../../src/features/operations/StatusCorrectionForm.js'
import { RecomposeForm } from '../../src/features/operations/RecomposeForm.js'
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

// The real batch list the picker reads. The operator picks by what a batch IS
// (size, status, trigger reason) rather than by an id they had to obtain
// elsewhere, which is the whole point of the step.
const BATCH_LIST = [{
  id: 'btch_1', status: 'BORN', triggerReason: 'LOT_SIZE', unitCount: 12,
  printVndr: null, triggeredByActor: null,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
}]
const BATCH_LIST_2 = [{
  id: 'btch_2', status: 'BORN', triggerReason: 'LOT_SIZE', unitCount: 34,
  printVndr: null, triggeredByActor: null,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
}]

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

  // FIVE tabs now: Hold is gone (step 8), because holding is an action on the
  // pool entry row it acts on rather than a form taking a typed id.
  it('renders the Operations heading and its five tabs', () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})))
    render(withProviders(<OperationsPage />))
    expect(screen.getByRole('heading', { name: /operations/i })).toBeTruthy()
    for (const label of ['Batch', 'Status Correction', 'Recompose', 'Dispatch History', 'Destructive']) {
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

  // The batch TRIGGER moved to the pending pool it acts on (step 3). Its
  // coverage moved with it, to test/features/batchable-pools.test.tsx, which
  // asserts the same POST body and Idempotency-Key plus the grouping rules the
  // old form had no concept of.

  it('downloads the dispatch sheet for a PICKED batch, hitting GET /ops/batches/:btchId/dispatch-excel with a Bearer token, and saves the exact served bytes', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.endsWith('/ops/batches')) return jsonResponse(BATCH_LIST)
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

    await userEvent.click(await screen.findByRole('button', { name: /12 records/ }))
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

  it('downloads collateral for a PICKED batch + artifact type, hitting GET /ops/batches/:btchId/collateral/:artifactType', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.endsWith('/ops/batches')) return jsonResponse(BATCH_LIST_2)
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

    await userEvent.click(await screen.findByRole('button', { name: /34 records/ }))
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
        if (url.endsWith('/ops/batches')) return jsonResponse(BATCH_LIST)
        if (url.includes('/collateral/')) return new Response(null, { status: 404 })
        return jsonResponse({})
      }),
    )

    render(withProviders(<BatchPage />))

    await userEvent.click(await screen.findByRole('button', { name: /12 records/ }))
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

const RECOMPOSE_POOL = [{
  asgnId: 'asgn_1', merchantDisplayName: 'BRILLIANT PERFUME', merchantLegalName: 'BRILLIANT PERFUME',
  bankReferenceCode: '3', bankDisplayName: 'GSCB', branchCode: '30', soundbox: true,
  standeeCount: 1, stickerCount: 2, poolStatus: 'POOLED', dispatchState: null,
  shipToSuperseded: false, batch: null, createdAt: '2026-08-01T00:00:00.000Z',
  tenantId: 'tnnt_1', programId: 'prog_1',
}]

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
        if (url.includes('/ops/pool')) return jsonResponse(RECOMPOSE_POOL)
        if (url.includes('/ops/artifacts/recompose')) {
          return jsonResponse({ deduped: false, artifactId: 'artf_1' })
        }
        return jsonResponse({})
      }),
    )

    render(withProviders(<RecomposeForm />))

    // Picked by MERCHANT NAME, never typed. The posted asgnId below proves the
    // component still sends the wire id the edge expects.
    await userEvent.click(await screen.findByRole('button', { name: /BRILLIANT PERFUME/ }))
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
        if (url.includes('/ops/pool')) return jsonResponse(RECOMPOSE_POOL)
        return jsonResponse({ deduped: false, artifactId: 'artf_2' })
      }),
    )

    render(withProviders(<RecomposeForm />))

    await userEvent.click(await screen.findByRole('button', { name: /BRILLIANT PERFUME/ }))
    await userEvent.selectOptions(screen.getByLabelText(/artifact type/i), 'STANDEE_IMG')
    await userEvent.type(screen.getByLabelText(/requested ship.to/i), '5 New St')
    await userEvent.click(screen.getByRole('button', { name: /recompose/i }))

    expect(await screen.findByText(/artf_2/)).toBeTruthy()
    const call = calls.find((c) => c.url.includes('/ops/artifacts/recompose'))!
    const body = parseBody(call)
    expect(body.requestedShipTo).toBe('5 New St')
  })
})

// HoldButton is DELETED (step 8). It was a form asking for a typed asgn_ id;
// holding is now an action on the pool entry row it acts on, where the row's own
// status decides whether Hold or Release even applies. Covered by
// test/features/pool-entry-actions.test.tsx.

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

    render(withProviders(<DispatchHistoryPage onCorrectStatus={() => {}} onOverrideTerminal={() => {}} />))

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
    render(withProviders(<DispatchHistoryPage onCorrectStatus={onCorrectStatus} onOverrideTerminal={() => {}} />))

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
    render(withProviders(<DispatchHistoryPage onCorrectStatus={onCorrectStatus} onOverrideTerminal={() => {}} />))

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

// Dispatch History was the last table still showing our field names as its
// column headers, and the last screen still asking the operator to TYPE a bank
// and a status that both come from a known set. Redesign step 5 fixed exactly
// those two filters on Reports; this is the same fix on the screen that was
// missed.
describe('DispatchHistoryPage: our field names and typed filters', () => {
  const ROW = {
    dispatchId: 'asgn_1',
    programId: '11111111-1111-4111-8111-111111111111',
    bankCode: '3',
    merchantDisplay: 'Flow Alpha Store',
    awb: 'AWB1',
    shptId: 'shpt_1',
  }
  const BANKS = [{ tnntId: 'tnnt_1', bankReferenceCode: '3', displayName: 'GSCB', status: 'ACTIVE' }]

  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  function stubHistory(): { url: string }[] {
    const calls: { url: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push({ url })
        if (url.includes('/ops/bank-masters')) return jsonResponse(BANKS)
        return jsonResponse({ rows: [ROW], watermark: { asOf: null, perTopic: {} } })
      }),
    )
    return calls
  }

  function renderHistory() {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <DispatchHistoryPage onCorrectStatus={() => {}} onOverrideTerminal={() => {}} />
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  it('gives every column a header a human reads, not the backend key', async () => {
    stubHistory()
    renderHistory()
    expect(await screen.findByRole('columnheader', { name: 'Merchant Display' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Dispatch Id' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Bank Code' })).toBeTruthy()
    // The raw camelCase key must not survive as a header.
    expect(screen.queryByRole('columnheader', { name: 'merchantDisplay' })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'dispatchId' })).toBeNull()
  })

  it('offers the real banks instead of a text box', async () => {
    stubHistory()
    renderHistory()
    const bank = await screen.findByLabelText(/bank/i)
    expect(bank.tagName).toBe('SELECT')
    expect(await within(bank as HTMLSelectElement).findByRole('option', { name: 'GSCB' })).toBeTruthy()
    expect(within(bank as HTMLSelectElement).getByRole('option', { name: /any bank/i })).toBeTruthy()
  })

  it('offers the real courier statuses instead of a text box', async () => {
    stubHistory()
    renderHistory()
    const status = await screen.findByLabelText(/^status/i)
    expect(status.tagName).toBe('SELECT')
    expect(within(status as HTMLSelectElement).getByRole('option', { name: 'DELIVERED' })).toBeTruthy()
  })

  it('sends the picked bank CODE, not its display name', async () => {
    const calls = stubHistory()
    renderHistory()
    await userEvent.selectOptions(await screen.findByLabelText(/bank/i), '3')
    await userEvent.click(screen.getByRole('button', { name: /search/i }))
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('bank=3'))).toBe(true)
    })
    expect(calls.some((c) => c.url.includes('bank=GSCB'))).toBe(false)
  })
})
