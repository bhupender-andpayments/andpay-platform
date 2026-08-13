import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { ActivationPage } from '../../src/features/activation/ActivationPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// FR-07 Phase-1 MANUAL activation SUCCESS mark (Phase 7 Task 11, D-H.1). The
// confirmed ops-edge contract (apps/ops-edge/src/ops.controller.ts's
// activateAssignmentRoute + services/analytics/src/mediation.ts's
// activationRow, docs/plan/phase7_grounding/B_edge_contracts.md row #11):
//   GET  /ops/reports/activation   -> { rows: ReportRow[], watermark }
//     (server-filtered to soundbox-or-legacy rows with activation_status
//     IS NULL: every row awaiting activation. The delivery half of that
//     filter went away with D-16 / T4.2. Row shape copied verbatim from
//     mediation.ts's activationRow, never invented here.)
//   POST /ops/assignments/activate  body { dispatchId } -> { activated }
//     (dispatchId IS the wire asgn id; NOT step-up-gated.)
// C3 fence: SUCCESS path only. No failure-mark control, no distinct
// SIM-activation control (simActivationStatus mirrors activationStatus and
// is read-only text in v1).

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

function renderActivationPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <ActivationPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('ActivationPage', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('lists DELIVERED (activation-report) assignments from GET /ops/reports/activation', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return jsonResponse({
          rows: [
            {
              dispatchId: 'asgn_1',
              programId: 'prg_1',
              bankCode: 'HDFC',
              merchantDisplay: 'Acme Traders',
              deviceIds: ['DEV-1'],
              deliveryDate: '2026-08-01T00:00:00.000Z',
              activationStatus: null,
              simActivationStatus: null,
              activationDate: null,
              activationFailureReason: null,
            },
          ],
          watermark: { asOf: '2026-08-05T00:00:00.000Z', perTopic: {} },
        })
      }),
    )

    renderActivationPage()

    expect(await screen.findByText('asgn_1')).toBeTruthy()
    expect(screen.getByText('Acme Traders')).toBeTruthy()
    const call = calls.find((c) => c.url.includes('/ops/reports/activation'))
    expect(call).toBeTruthy()
    expect(call!.init.method).toBe('GET')
  })

  it('marking a DELIVERED assignment calls ops:mark-activated (POST /ops/assignments/activate) with the wire asgn id + an Idempotency-Key', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/assignments/activate')) return jsonResponse({ activated: true })
        return jsonResponse({
          rows: [
            {
              dispatchId: 'asgn_delivered',
              bankCode: 'HDFC',
              merchantDisplay: 'Acme Traders',
              deviceIds: ['DEV-1'],
              deliveryDate: '2026-08-01T00:00:00.000Z',
              activationStatus: null,
              simActivationStatus: null,
              activationFailureReason: null,
            },
          ],
          watermark: { asOf: null, perTopic: {} },
        })
      }),
    )

    renderActivationPage()

    const row = (await screen.findByText('asgn_delivered')).closest('tr')!
    const button = within(row).getByRole('button', { name: /mark activated/i })
    expect((button as HTMLButtonElement).disabled).toBe(false)

    await userEvent.click(button)

    const call = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/ops/assignments/activate'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(call.init.method).toBe('POST')
    const body = parseBody(call)
    expect(body.dispatchId).toBe('asgn_delivered')
    expect(headerValue(call, 'Idempotency-Key')).toBeTruthy()
  })

  // THE RE-PIN (D-16, T4.2). This used to assert the control was disabled,
  // which pinned the delivered-gate as a rule. Activation no longer waits on
  // delivery, so an undelivered row is markable and the cell says plainly that
  // delivery has not happened yet rather than leaving a blank that would read
  // as missing data.
  it('an UNDELIVERED assignment IS markable, and its delivery cell says so rather than sitting blank', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return jsonResponse({
          rows: [
            {
              dispatchId: 'asgn_not_delivered',
              bankCode: 'HDFC',
              merchantDisplay: 'Acme Traders',
              deviceIds: ['DEV-2'],
              deliveryDate: null,
              activationStatus: null,
              simActivationStatus: null,
              activationFailureReason: null,
            },
          ],
          watermark: { asOf: null, perTopic: {} },
        })
      }),
    )

    renderActivationPage()

    const row = (await screen.findByText('asgn_not_delivered')).closest('tr')!
    expect(within(row).getByText(/not yet delivered/i)).toBeTruthy()
    const button = within(row).getByRole('button', { name: /mark activated/i }) as HTMLButtonElement
    expect(button.disabled).toBe(false)

    await userEvent.click(button)

    const write = calls.find((c) => c.url.includes('/ops/assignments/activate'))
    expect(write).toBeTruthy()
    expect(JSON.parse(String(write!.init.body)).dispatchId).toBe('asgn_not_delivered')
  })

  // D-19 (T5.4): bulk marking, and the shape of the objection it had to answer.
  // The recorded refusal was that a client-side loop failing halfway leaves an
  // operator unable to tell which records went through. So the result is per
  // row, and the confirmation counts what HAPPENED rather than what was asked.
  describe('bulk mark activated', () => {
    const TWO_ROWS = {
      rows: [
        {
          dispatchId: 'asgn_a',
          bankCode: 'HDFC',
          merchantDisplay: 'Alpha Store',
          deviceIds: ['DEV-A'],
          deliveryDate: '2026-08-09T06:30:00.000Z',
          activationStatus: null,
          simActivationStatus: null,
          activationFailureReason: null,
        },
        {
          dispatchId: 'asgn_b',
          bankCode: 'HDFC',
          merchantDisplay: 'Beta Store',
          deviceIds: ['DEV-B'],
          deliveryDate: null,
          activationStatus: null,
          simActivationStatus: null,
          activationFailureReason: null,
        },
      ],
      watermark: { asOf: null, perTopic: {} },
    }

    function stubBulk(results: { dispatchId: string; activated: boolean; reason: string | null }[]): Call[] {
      const calls: Call[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push({ url, init })
          if (url.includes('/ops/assignments/activate-bulk')) return jsonResponse({ results })
          return jsonResponse(TWO_ROWS)
        }),
      )
      return calls
    }

    it('posts only the ticked rows, and nothing at all with none ticked', async () => {
      const calls = stubBulk([{ dispatchId: 'asgn_a', activated: true, reason: null }])
      renderActivationPage()

      const bulkButton = (await screen.findByRole('button', { name: /mark selected activated/i })) as HTMLButtonElement
      expect(bulkButton.disabled).toBe(true)

      await userEvent.click(screen.getByLabelText('Select Alpha Store'))
      // The label counts the selection, so an operator can see what they are
      // about to act on before they act on it.
      await userEvent.click(await screen.findByRole('button', { name: /mark 1 activated/i }))

      const write = calls.find((c) => c.url.includes('/ops/assignments/activate-bulk'))
      expect(write).toBeTruthy()
      expect(parseBody(write!).dispatchIds).toEqual(['asgn_a'])
    })

    it('reports what ACTUALLY happened per row, never what was asked for', async () => {
      stubBulk([
        { dispatchId: 'asgn_a', activated: true, reason: null },
        { dispatchId: 'asgn_b', activated: false, reason: 'not-activatable' },
      ])
      renderActivationPage()

      await userEvent.click(await screen.findByLabelText('Select Alpha Store'))
      await userEvent.click(screen.getByLabelText('Select Beta Store'))
      await userEvent.click(screen.getByRole('button', { name: /mark 2 activated/i }))

      // 1 of 2, not 2. Claiming both is the exact failure the refusal named.
      expect(await screen.findByText(/1 of 2 marked activated/i)).toBeTruthy()
      // And the row that did not go through says why, next to itself, in words
      // rather than in the edge's code vocabulary.
      expect(screen.getByText(/collateral does not activate/i)).toBeTruthy()
    })
  })

  it('has NO failure-mark control and NO distinct SIM-activation control anywhere on the page (C3 fence)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          rows: [
            {
              dispatchId: 'asgn_1',
              bankCode: 'HDFC',
              merchantDisplay: 'Acme Traders',
              deviceIds: ['DEV-1'],
              deliveryDate: '2026-08-01T00:00:00.000Z',
              activationStatus: null,
              simActivationStatus: null,
              activationFailureReason: null,
            },
          ],
          watermark: { asOf: null, perTopic: {} },
        }),
      ),
    )

    renderActivationPage()
    await screen.findByText('asgn_1')

    // No failure-mark button/control of any kind.
    expect(screen.queryByRole('button', { name: /fail/i })).toBeNull()
    // No distinct, editable SIM-activation control (input/select); SIM status
    // is read-only text only.
    expect(screen.queryByRole('button', { name: /sim/i })).toBeNull()
    expect(screen.queryByLabelText(/sim/i)).toBeNull()
    expect(screen.queryAllByRole('combobox').length).toBe(0)
    // Only one write control per row: "Mark activated".
    expect(screen.getAllByRole('button', { name: /mark activated/i })).toHaveLength(1)
  })
})

// The worklist reads the ANALYTICS projection, which the fact rail feeds
// asynchronously, while the activation WRITE lands in TMS. So the re-read that
// already followed a successful mark could legitimately return the row again,
// and did: the operator saw a confirmation and the row they had just actioned
// still sitting there, still offering the button. That is a read-your-own-write
// problem over an eventually consistent view, NOT a missing refetch.
describe('ActivationPage: a row the operator has just actioned', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  function stubWithStaleProjection(): Call[] {
    const calls: Call[] = []
    const row = {
      dispatchId: 'asgn_stale',
      programId: 'prg_1',
      bankCode: 'HDFC',
      merchantDisplay: 'Stale Projection Store',
      deviceIds: ['DEV-9'],
      deliveryDate: '2026-08-01T00:00:00.000Z',
      activationStatus: null,
      simActivationStatus: null,
      activationDate: null,
      activationFailureReason: null,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/assignments/activate')) return jsonResponse({ activated: true })
        // Deliberately ALWAYS returns the row, which is exactly what a
        // projection that has not caught up does.
        return jsonResponse({ rows: [row], watermark: { asOf: null, perTopic: {} } })
      }),
    )
    return calls
  }

  it('leaves the worklist even when the projection still returns it', async () => {
    stubWithStaleProjection()
    renderActivationPage()

    expect(await screen.findByText('Stale Projection Store')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /mark activated/i }))

    await vi.waitFor(() => {
      expect(screen.queryByText('Stale Projection Store')).toBeNull()
    })
  })

  it('counts what it is showing, so the header cannot claim a row the table does not have', async () => {
    stubWithStaleProjection()
    renderActivationPage()

    expect(await screen.findByText('Stale Projection Store')).toBeTruthy()
    expect(screen.getByText('1 row')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /mark activated/i }))

    await vi.waitFor(() => {
      expect(screen.getByText('0 rows')).toBeTruthy()
    })
  })

  it('names the merchant in the confirmation rather than the wire id', async () => {
    stubWithStaleProjection()
    renderActivationPage()

    expect(await screen.findByText('Stale Projection Store')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /mark activated/i }))

    await vi.waitFor(() => {
      expect(screen.getByText(/Stale Projection Store marked activated/)).toBeTruthy()
    })
    expect(screen.queryByText(/asgn_stale marked activated/)).toBeNull()
  })

  it('formats the delivered date rather than printing the wire ISO string', async () => {
    stubWithStaleProjection()
    renderActivationPage()

    expect(await screen.findByText('Stale Projection Store')).toBeTruthy()
    expect(screen.queryByText('2026-08-01T00:00:00.000Z')).toBeNull()
  })
})
