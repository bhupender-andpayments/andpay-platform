import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { VendorSuspendButton } from '../../src/features/destructive/VendorSuspendButton.js'
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
// - terminal-override moved to the shipment detail page as a dialog
//   (ShipmentActionDialogs.tsx, 2026-08-14) and is covered by
//   shipment-detail.test.tsx; only the vendor-suspend coverage lives here now.
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

// The TerminalOverrideForm / DispatchesPage-row-action suites that used to live
// below are gone with the components they tested (2026-08-14): the override
// moved to the shipment detail page as a dialog (ShipmentActionDialogs.tsx),
// covered by shipment-detail.test.tsx. The step-up retry contract is still
// covered above via VendorSuspendButton, which shares the same client
// interceptor path.
