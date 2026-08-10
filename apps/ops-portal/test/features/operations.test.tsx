import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { DispatchesPage } from '../../src/features/dispatches/DispatchesPage.js'
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
//   GET  /ops/batches/:btchId/excel/:group               -> binary xlsx
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

describe('DispatchesPage: Operations dissolved into the object it acts on', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  // The old page had FIVE tabs and made correcting a status a four-step
  // navigation that ended on a shipment identified only by a wire id. Section 4
  // said it should dissolve; this asserts it did, and that nothing here is a tab
  // any more.
  it('has no tab strip at all', () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ rows: [], watermark: { asOf: null, perTopic: {} } })))
    render(withProviders(<DispatchesPage />))
    expect(screen.getByRole('heading', { name: /dispatches/i })).toBeTruthy()
    for (const gone of ['Batch', 'Status Correction', 'Recompose', 'Dispatch History', 'Destructive']) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull()
    }
  })

  // The correction form is ABSENT until a row asks for it, rather than being a
  // destination that greets you with "No shipment selected, go elsewhere".
  it('shows no correction form until a row is chosen', () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ rows: [], watermark: { asOf: null, perTopic: {} } })))
    render(withProviders(<DispatchesPage />))
    expect(screen.queryByText(/no shipment selected/i)).toBeNull()
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
    expect(screen.queryByRole('region', { name: 'Correct status' })).toBeNull()
  })

  it('with a selected row whose shptId is null: refuses to render a correctable form (guard)', () => {
    render(withProviders(<StatusCorrectionForm selectedRow={{ dispatchId: 'asgn_1', awb: 'AWB-9', shptId: null }} />))

    expect(screen.getByText(/no verified wire shipment id/i)).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Correct status' })).toBeNull()
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

describe('DispatchesPage integration: selecting a dispatch-history row drives Status Correction', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('clicking Correct status on a real-shptId row opens the correction form in place, pre-selected with that row, and submitting sends the SAME wire shptId (not the row awb/dispatchId)', async () => {
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

    render(withProviders(<DispatchesPage />))

    const row = (await screen.findByText('AWB-1')).closest('tr')!
    await userEvent.click(within(row).getByRole('button', { name: /correct status/i }))

    // The form opened IN PLACE, with the real shptId already shown. No tab
    // was entered, because there are none.
    const correctionForm = within(screen.getByRole('region', { name: 'Correct status' }))
    expect(correctionForm.getByRole('button', { name: /submit correction/i })).toBeTruthy()
    // Appears twice now, in the form AND in the row it was taken from,
    // because the form opens on the same page as the table. That is the
    // point of the move, so assert presence rather than uniqueness.
    expect(screen.getAllByText('shpt_from_row').length).toBeGreaterThan(0)
    expect(screen.queryByRole('textbox', { name: /shipment/i })).toBeNull()

    await userEvent.selectOptions(correctionForm.getByLabelText(/status/i), 'DELIVERED')
    await userEvent.type(correctionForm.getByLabelText(/courier timestamp/i), '2026-08-01T10:00')
    await userEvent.click(correctionForm.getByRole('button', { name: /submit correction/i }))

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

    render(withProviders(<DispatchesPage />))

    const row = (await screen.findByText('AWB-2')).closest('tr')!
    const button = within(row).getByRole('button', { name: /correct status/i }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    // The form never opened: there is no tab to be 'still on' any more, so
    // the assertion is that the correction surface is simply absent.
    expect(screen.queryByRole('region', { name: 'Correct status' })).toBeNull()
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

// Moved here from the Batches page's third tab. Batches is about what is
// waiting and what formed; a shipment's carrier status is a property of the
// DISPATCH, and section 4 lists getDispatches among this section's reads.
describe('DispatchesPage: the shipments region', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  const SHIPMENT = {
    id: 'shpt_1', awb: 'AWB-12345', status: 'IN_TRANSIT', courierPartner: 'BlueDart',
    dispatchDate: '2026-08-01T00:00:00.000Z', statusAt: '2026-08-02T00:00:00.000Z', statusSource: 'WEBHOOK',
  }

  it('lists shipments and sends ?status when the carrier filter is used', async () => {
    const calls: { url: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push({ url })
      if (url.includes('/ops/dispatches')) return jsonResponse([SHIPMENT])
      return jsonResponse({ rows: [], watermark: { asOf: null, perTopic: {} } })
    }))

    render(withProviders(<DispatchesPage />))

    expect(await screen.findByText('AWB-12345')).toBeTruthy()
    await userEvent.selectOptions(screen.getByLabelText(/carrier status/i), 'DELIVERED')
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('status=DELIVERED'))).toBe(true)
    })
  })
})
