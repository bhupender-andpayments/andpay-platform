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
//     (server-filtered to delivery_date IS NOT NULL AND activation_status
//     IS NULL: the delivered, not-yet-activated worklist. Row shape copied
//     verbatim from mediation.ts's activationRow, never invented here.)
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

  it('a non-DELIVERED assignment (null deliveryDate) is NOT markable: its control is disabled and no write fires', async () => {
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
    const button = within(row).getByRole('button', { name: /mark activated/i }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    await userEvent.click(button)

    expect(calls.some((c) => c.url.includes('/ops/assignments/activate'))).toBe(false)
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
