import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { DispatchesPage } from '../../src/features/dispatches/DispatchesPage.js'
import { DispatchHistoryPage } from '../../src/features/operations/DispatchHistoryPage.js'
import { VendorSuspendButton } from '../../src/features/destructive/VendorSuspendButton.js'
import { TerminalOverrideForm } from '../../src/features/destructive/TerminalOverrideForm.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// Phase 7 Task 10 (reskin of the spec-13 destructive actions): the three
// step-up-gated writes, OPS_STEP_UP_GATED_OPERATIONS = ['terminal-override',
// 'hold-release', 'vendor-suspend'] (packages/authz/src/stepup-operations.ts,
// a spine file, untouched). The confirmed ops-edge contract
// (apps/ops-edge/src/ops.controller.ts):
//   POST /ops/records/:asgnId/release   (no body)                                      stepUpKey 'hold-release'
//   POST /ops/vendors/:id/suspend       (no body)                                       stepUpKey 'vendor-suspend'
//   POST /ops/shipments/:id/override    { status, courierTimestamp, overrideReason }    stepUpKey 'terminal-override'
//
// Two id-encoding gaps this task closes (both real wire ids now, no bridge):
// - vendor-suspend: GET /ops/vendors (getVendors) already emits a WIRE vndr
//   id (B_edge_contracts.md #14, MATCH). VendorSuspendButton fetches the real
//   vendor list itself and suspends the SELECTED row's own `id` - never a
//   hand-typed value, and never the OBSOLETE ops-edge raw-uuid demo bridge
//   (BRIDGE-1, A_demo_screens.md), which this build does not import.
// - terminal-override: the G-SHPT backend slice (commit 354aa76) added a
//   real wire `shptId` to the soundbox-delivery report row (same column
//   Task 9's StatusCorrectionForm already consumes via reportRowShptId()).
//   TerminalOverrideForm is un-gated the identical way: driven ONLY by a
//   selectedRow the operator picks on Dispatch History, never a free-text
//   shpt-id field. A row whose shptId is null must never be overridable.
//
// The reactive step-up path itself (../../src/api/client.ts's 403
// interceptor + ../../src/auth/StepUpDialog.tsx) is SPINE and untouched;
// these tests render the REAL AuthProvider (which mounts the real dialog)
// and prove the destructive actions drive it correctly on a 403, and are
// otherwise ordinary calls on a fresh AAL2 session (no proactive prompt).

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

// HoldReleaseButton is DELETED (step 8), for the same reason as HoldButton and
// into the same place. Its step-up gate is unaffected: 'hold-release' is still
// in OPS_STEP_UP_GATED_OPERATIONS and the round trip is owned by the client
// interceptor and StepUpDialog, never by the calling component. Covered by
// test/features/pool-entry-actions.test.tsx.

describe('VendorSuspendButton (driven by a real listVendors wire id, no raw-uuid bridge)', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('lists real vendors from GET /ops/vendors and suspends the SELECTED row using its own wire id, never a hand-typed value', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/vendors') && (init.method === undefined || init.method === 'GET')) {
          return jsonResponse([
            {
              id: 'vndr_wire_1',
              type: 'COURIER',
              displayName: 'Speedy Couriers',
              status: 'ACTIVE_VENDOR',
              courierCode: 'SPD',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ])
        }
        if (url.includes('/ops/vendors/vndr_wire_1/suspend')) return jsonResponse({ deduped: false })
        return jsonResponse({})
      }),
    )

    render(withProviders(<VendorSuspendButton />))

    const row = (await screen.findByText('Speedy Couriers')).closest('tr')!
    await userEvent.click(within(row).getByRole('button', { name: /suspend/i }))

    expect(await screen.findByText(/vndr_wire_1/)).toBeTruthy()

    const call = calls.find((c) => c.url.includes('/ops/vendors/') && c.url.includes('/suspend'))
    expect(call).toBeTruthy()
    // Proves the WIRE id from the fetched row drove the URL: never a raw
    // uuid, never the demo ops-edge bridge's synthesized encoding.
    expect(call!.url).toContain('/ops/vendors/vndr_wire_1/suspend')
    expect(call!.init.method).toBe('POST')
    expect(headerValue(call!, 'Idempotency-Key')).toBeTruthy()
    expect(call!.init.body).toBeUndefined()
  })

  it('renders no free-text vendor-id input of any kind', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([
          {
            id: 'vndr_1',
            type: 'PRINT',
            displayName: 'PrintCo',
            status: 'ACTIVE_VENDOR',
            courierCode: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      ),
    )
    render(withProviders(<VendorSuspendButton />))
    await screen.findByText('PrintCo')
    expect(screen.queryByRole('textbox', { name: /vendor/i })).toBeNull()
    expect(screen.queryByLabelText(/vendor id/i)).toBeNull()
  })

  it('a 403 on the selected row drives the REAL TOTP dialog once, steps up, and retries ONCE with the SAME Idempotency-Key', async () => {
    const calls: Call[] = []
    let suspendCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/vendors') && (init.method === undefined || init.method === 'GET')) {
          return jsonResponse([
            {
              id: 'vndr_wire_2',
              type: 'MANUFACTURER',
              displayName: 'Boxworks',
              status: 'ACTIVE_VENDOR',
              courierCode: null,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ])
        }
        if (url.includes('/ops/vendors/vndr_wire_2/suspend')) {
          suspendCallCount += 1
          if (suspendCallCount === 1) return jsonResponse(null, 403)
          return jsonResponse({ deduped: false })
        }
        if (url.includes('/session/stepup')) return jsonResponse({ accessToken: 'tok-2' })
        return jsonResponse({})
      }),
    )

    render(withProviders(<VendorSuspendButton />))

    const row = (await screen.findByText('Boxworks')).closest('tr')!
    await userEvent.click(within(row).getByRole('button', { name: /suspend/i }))

    const totpInput = await screen.findByLabelText(/totp/i)
    await userEvent.type(totpInput, '111111')
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))

    expect(await screen.findByText(/vndr_wire_2/)).toBeTruthy()

    const suspendCalls = calls.filter((c) => c.url.includes('/ops/vendors/vndr_wire_2/suspend'))
    expect(suspendCalls.length).toBe(2)
    const keyFirst = headerValue(suspendCalls[0]!, 'Idempotency-Key')
    expect(keyFirst).toBeTruthy()
    expect(headerValue(suspendCalls[1]!, 'Idempotency-Key')).toBe(keyFirst)
  })

  // Check 3 (not-an-authority): the control renders enabled regardless of any
  // client-side notion of permission (there is no scope field on the display
  // principal to gate on, S24/T14). Even so, when the edge denies both
  // before AND after a successful step-up, the SPA surfaces the denial and
  // never renders a success/granted state.
  it('a 403 that persists after step-up is surfaced, never granted client-side (no further retry loop)', async () => {
    const calls: Call[] = []
    let suspendCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/vendors') && (init.method === undefined || init.method === 'GET')) {
          return jsonResponse([
            {
              id: 'vndr_wire_3',
              type: 'COURIER',
              displayName: 'DeniedCo',
              status: 'ACTIVE_VENDOR',
              courierCode: 'DEN',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ])
        }
        if (url.includes('/ops/vendors/vndr_wire_3/suspend')) {
          suspendCallCount += 1
          return jsonResponse(null, 403) // denied both before AND after step-up
        }
        if (url.includes('/session/stepup')) return jsonResponse({ accessToken: 'tok-2' })
        return jsonResponse({})
      }),
    )

    render(withProviders(<VendorSuspendButton />))

    const row = (await screen.findByText('DeniedCo')).closest('tr')!
    const button = within(row).getByRole('button', { name: /suspend/i }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    await userEvent.click(button)

    const totpInput = await screen.findByLabelText(/totp/i)
    await userEvent.type(totpInput, '222222')
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText(/vndr_wire_3.*suspended/i)).toBeNull()
    expect(suspendCallCount).toBe(2) // one attempt, one retry after step-up: no further loop
  })
})

describe('TerminalOverrideForm (G-SHPT closed: driven only by a selected dispatch-history row)', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('with no row selected: shows guidance, renders no shipment-id input of any kind, and cannot submit', () => {
    render(withProviders(<TerminalOverrideForm selectedRow={null} />))

    expect(screen.getByText(/select a shipment/i)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: /shipment/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^override$/i })).toBeNull()
  })

  it('with a selected row whose shptId is null: refuses to render an overridable form (guard)', () => {
    render(withProviders(<TerminalOverrideForm selectedRow={{ dispatchId: 'asgn_1', awb: 'AWB-9', shptId: null }} />))

    expect(screen.getByText(/no verified wire shipment id/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^override$/i })).toBeNull()
  })

  it('with a selected row carrying a real shptId: renders it as static text (no editable input) and posts that SAME wire shptId to /ops/shipments/:id/override', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/shipments/shpt_real1/override')) {
          return jsonResponse({ deduped: false, overridden: true })
        }
        return jsonResponse({})
      }),
    )

    render(
      withProviders(<TerminalOverrideForm selectedRow={{ dispatchId: 'asgn_1', awb: 'AWB-1', shptId: 'shpt_real1' }} />),
    )

    expect(screen.getByText('shpt_real1')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: /shipment/i })).toBeNull()

    await userEvent.selectOptions(screen.getByLabelText(/status/i), 'DELIVERED')
    await userEvent.type(screen.getByLabelText(/courier timestamp/i), '2026-08-01T10:00')
    await userEvent.type(screen.getByLabelText(/override reason/i), 'Courier confirmed by phone')
    await userEvent.click(screen.getByRole('button', { name: /^override$/i }))

    expect(await screen.findByText(/overridden/i)).toBeTruthy()

    const call = calls.find((c) => c.url.includes('/ops/shipments/'))
    expect(call).toBeTruthy()
    // Proves the WIRE shptId from the row drove the URL, never the row's
    // other identifiers (dispatchId/awb).
    expect(call!.url).toContain('/ops/shipments/shpt_real1/override')
    expect(headerValue(call!, 'Idempotency-Key')).toBeTruthy()
    const body = parseBody(call!)
    expect(body.status).toBe('DELIVERED')
    expect(body.courierTimestamp).toBe('2026-08-01T10:00')
    expect(body.overrideReason).toBe('Courier confirmed by phone')
  })

  it('the status dropdown offers only the known courier statuses', () => {
    render(withProviders(<TerminalOverrideForm selectedRow={{ dispatchId: 'asgn_1', shptId: 'shpt_1' }} />))
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

  it('a 403 drives the REAL TOTP dialog once, steps up, and retries ONCE with the SAME Idempotency-Key', async () => {
    const calls: Call[] = []
    let overrideCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/shipments/shpt_stepup/override')) {
          overrideCallCount += 1
          if (overrideCallCount === 1) return jsonResponse(null, 403)
          return jsonResponse({ deduped: false, overridden: true })
        }
        if (url.includes('/session/stepup')) return jsonResponse({ accessToken: 'tok-2' })
        return jsonResponse({})
      }),
    )

    render(
      withProviders(<TerminalOverrideForm selectedRow={{ dispatchId: 'asgn_3', shptId: 'shpt_stepup' }} />),
    )

    await userEvent.type(screen.getByLabelText(/courier timestamp/i), '2026-08-01T10:00')
    await userEvent.type(screen.getByLabelText(/override reason/i), 'r')
    await userEvent.click(screen.getByRole('button', { name: /^override$/i }))

    const totpInput = await screen.findByLabelText(/totp/i)
    await userEvent.type(totpInput, '123456')
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))

    expect(await screen.findByText(/overridden/i)).toBeTruthy()

    const overrideCalls = calls.filter((c) => c.url.includes('/ops/shipments/shpt_stepup/override'))
    expect(overrideCalls.length).toBe(2)
    const keyFirst = headerValue(overrideCalls[0]!, 'Idempotency-Key')
    expect(keyFirst).toBeTruthy()
    expect(headerValue(overrideCalls[1]!, 'Idempotency-Key')).toBe(keyFirst)
  })
})

describe('DispatchHistoryPage: the Override action', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('a row WITH a real shptId has an enabled Override action that fires onOverrideTerminal with that row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          rows: [{ dispatchId: 'asgn_1', awb: 'AWB-1', shptId: 'shpt_real' }],
          watermark: { asOf: null, perTopic: {} },
        }),
      ),
    )
    const onOverrideTerminal = vi.fn()
    render(
      withProviders(
        <DispatchHistoryPage onCorrectStatus={() => {}} onOverrideTerminal={onOverrideTerminal} />,
      ),
    )

    const row = (await screen.findByText('AWB-1')).closest('tr')!
    const button = within(row).getByRole('button', { name: /override/i }) as HTMLButtonElement
    expect(button.disabled).toBe(false)

    await userEvent.click(button)
    expect(onOverrideTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchId: 'asgn_1', shptId: 'shpt_real' }),
    )
  })

  it('a row whose shptId is null must NOT be overridable: the Override action is disabled and never fires', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          rows: [{ dispatchId: 'asgn_2', awb: 'AWB-2', shptId: null }],
          watermark: { asOf: null, perTopic: {} },
        }),
      ),
    )
    const onOverrideTerminal = vi.fn()
    render(
      withProviders(
        <DispatchHistoryPage onCorrectStatus={() => {}} onOverrideTerminal={onOverrideTerminal} />,
      ),
    )

    const row = (await screen.findByText('AWB-2')).closest('tr')!
    const button = within(row).getByRole('button', { name: /override/i }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    await userEvent.click(button)
    expect(onOverrideTerminal).not.toHaveBeenCalled()
  })
})

describe('DispatchesPage integration: selecting a dispatch-history row drives Terminal Override', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('clicking Override on a real-shptId row opens the override form in place, pre-selected with that row, and submitting sends the SAME wire shptId (never the row awb/dispatchId)', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/reports/soundbox-delivery')) {
          return jsonResponse({
            rows: [{ dispatchId: 'asgn_1', awb: 'AWB-1', shptId: 'shpt_from_row' }],
            watermark: { asOf: null, perTopic: {} },
          })
        }
        if (url.includes('/ops/shipments/shpt_from_row/override')) {
          return jsonResponse({ deduped: false, overridden: true })
        }
        if (url.includes('/ops/vendors') && (init.method === undefined || init.method === 'GET')) return jsonResponse([])
        return jsonResponse({})
      }),
    )

    render(withProviders(<DispatchesPage />))

    const row = (await screen.findByText('AWB-1')).closest('tr')!
    await userEvent.click(within(row).getByRole('button', { name: /override/i }))

    const overrideForm = within(screen.getByRole('region', { name: 'Terminal override' }))
    expect(overrideForm.getByRole('button', { name: 'Override' })).toBeTruthy()
    // Shown in the form AND in the row it came from: one page now.
    expect(screen.getAllByText('shpt_from_row').length).toBeGreaterThan(0)
    expect(screen.queryByRole('textbox', { name: /shipment/i })).toBeNull()

    await userEvent.selectOptions(overrideForm.getByLabelText(/status/i), 'DELIVERED')
    await userEvent.type(overrideForm.getByLabelText(/courier timestamp/i), '2026-08-01T10:00')
    await userEvent.type(overrideForm.getByLabelText(/override reason/i), 'Confirmed with courier')
    await userEvent.click(overrideForm.getByRole('button', { name: /^override$/i }))

    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/shipments/shpt_from_row/override'))).toBe(true)
    })
    expect(calls.some((c) => c.url.includes('/ops/shipments/asgn_1/override'))).toBe(false)
    expect(calls.some((c) => c.url.includes('/ops/shipments/AWB-1/override'))).toBe(false)
  })

  it('a null-shptId row cannot reach Terminal Override: the action is disabled on Dispatch History', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/reports/soundbox-delivery')) {
          return jsonResponse({
            rows: [{ dispatchId: 'asgn_2', awb: 'AWB-2', shptId: null }],
            watermark: { asOf: null, perTopic: {} },
          })
        }
        if (url.includes('/ops/vendors')) return jsonResponse([])
        return jsonResponse({})
      }),
    )

    render(withProviders(<DispatchesPage />))

    const row = (await screen.findByText('AWB-2')).closest('tr')!
    const button = within(row).getByRole('button', { name: /override/i }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    await userEvent.click(button)
    // The form never opened: there is no tab to be 'still on' any more, so
    // the assertion is that the override surface is simply absent.
    expect(screen.queryByRole('region', { name: 'Terminal override' })).toBeNull()
  })
})
