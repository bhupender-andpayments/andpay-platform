import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { TerminalOverrideForm } from '../../src/features/destructive/TerminalOverrideForm.js'
import { HoldReleaseButton } from '../../src/features/destructive/HoldReleaseButton.js'
import { VendorSuspendButton } from '../../src/features/destructive/VendorSuspendButton.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// Task 15 (spec 13, checks 2 and 3): the three step-up-gated destructive
// actions. The confirmed ops-edge contract (task 15 brief, grounded against
// apps/ops-edge/src/ops.controller.ts):
//   POST /ops/shipments/:id/override  { status, courierTimestamp, overrideReason } -> { deduped, overridden }
//   POST /ops/records/:asgnId/release (no body)                                   -> { deduped, released }
//   POST /ops/vendors/:id/suspend     (no body)                                   -> { deduped }
// All three carry stepUpKey values from @andpay/authz/stepup-operations'
// OPS_STEP_UP_GATED_OPERATIONS ('terminal-override' | 'hold-release' |
// 'vendor-suspend'), so a 403 from the edge drives the REAL client
// interceptor (Task 6) + REAL StepUpDialog (Task 8), rendered here inside
// the real AuthProvider (not a stub), per check 2.

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
    <MemoryRouter>
      <AuthProvider>{children}</AuthProvider>
    </MemoryRouter>
  )
}

describe('TerminalOverrideForm', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('the status dropdown offers only the known courier statuses (same set as Task 14)', () => {
    render(withProviders(<TerminalOverrideForm />))
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

  it('check 2: a 403 drives the REAL TOTP dialog, steps up, and retries ONCE with the SAME Idempotency-Key', async () => {
    const calls: Call[] = []
    let overrideCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/shipments/shpt_1/override')) {
          overrideCallCount += 1
          if (overrideCallCount === 1) return jsonResponse(null, 403)
          return jsonResponse({ deduped: false, overridden: true })
        }
        if (url.includes('/session/stepup')) return jsonResponse({ accessToken: 'tok-2' })
        return jsonResponse({})
      }),
    )

    render(withProviders(<TerminalOverrideForm />))

    await userEvent.type(screen.getByLabelText(/shipment id/i), 'shpt_1')
    await userEvent.selectOptions(screen.getByLabelText(/status/i), 'DELIVERED')
    await userEvent.type(screen.getByLabelText(/courier timestamp/i), '2026-08-01T10:00')
    await userEvent.type(screen.getByLabelText(/override reason/i), 'courier confirmed by phone')
    await userEvent.click(screen.getByRole('button', { name: /override/i }))

    // the REAL StepUpDialog appears, driven by the REAL client interceptor
    const totpInput = await screen.findByLabelText(/totp/i)
    await userEvent.type(totpInput, '123456')
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))

    expect(await screen.findByText(/overridden/i)).toBeTruthy()

    const stepupCall = calls.find((c) => c.url.includes('/session/stepup'))
    expect(stepupCall).toBeTruthy()
    expect(parseBody(stepupCall!).totp).toBe('123456')

    const overrideCalls = calls.filter((c) => c.url.includes('/ops/shipments/shpt_1/override'))
    expect(overrideCalls.length).toBe(2)
    const keyFirst = headerValue(overrideCalls[0]!, 'Idempotency-Key')
    const keySecond = headerValue(overrideCalls[1]!, 'Idempotency-Key')
    expect(keyFirst).toBeTruthy()
    expect(keySecond).toBe(keyFirst)

    // the body carries the free-text override reason and the known status
    const body = parseBody(overrideCalls[0]!)
    expect(body.status).toBe('DELIVERED')
    expect(body.courierTimestamp).toBe('2026-08-01T10:00')
    expect(body.overrideReason).toBe('courier confirmed by phone')
  })

  it('a cancelled step-up surfaces the denial and does not loop (no retry, no stepup after cancel)', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/shipments/shpt_2/override')) return jsonResponse(null, 403)
        return jsonResponse({})
      }),
    )

    render(withProviders(<TerminalOverrideForm />))

    await userEvent.type(screen.getByLabelText(/shipment id/i), 'shpt_2')
    await userEvent.type(screen.getByLabelText(/courier timestamp/i), '2026-08-01T10:00')
    await userEvent.type(screen.getByLabelText(/override reason/i), 'test')
    await userEvent.click(screen.getByRole('button', { name: /override/i }))

    await screen.findByLabelText(/totp/i)
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText(/overridden/i)).toBeNull()
    // exactly the one failed attempt: no stepup call, no retry
    expect(calls.filter((c) => c.url.includes('/ops/shipments/shpt_2/override')).length).toBe(1)
    expect(calls.some((c) => c.url.includes('/session/stepup'))).toBe(false)
  })
})

describe('HoldReleaseButton', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('posts to /ops/records/:asgnId/release with NO body once an immediate 200 is returned', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/records/asgn_1/release')) return jsonResponse({ deduped: false, released: true })
        return jsonResponse({})
      }),
    )

    render(withProviders(<HoldReleaseButton />))

    await userEvent.type(screen.getByLabelText(/assignment id/i), 'asgn_1')
    await userEvent.click(screen.getByRole('button', { name: /release/i }))

    expect(await screen.findByText(/released/i)).toBeTruthy()

    const call = calls.find((c) => c.url.includes('/ops/records/asgn_1/release'))
    expect(call).toBeTruthy()
    expect(call!.init.method).toBe('POST')
    expect(headerValue(call!, 'Idempotency-Key')).toBeTruthy()
    expect(call!.init.body).toBeUndefined()
  })

  it('check 2: a 403 drives the real dialog, steps up, and retries once with the same key', async () => {
    const calls: Call[] = []
    let releaseCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/records/asgn_2/release')) {
          releaseCallCount += 1
          if (releaseCallCount === 1) return jsonResponse(null, 403)
          return jsonResponse({ deduped: false, released: true })
        }
        if (url.includes('/session/stepup')) return jsonResponse({ accessToken: 'tok-2' })
        return jsonResponse({})
      }),
    )

    render(withProviders(<HoldReleaseButton />))

    await userEvent.type(screen.getByLabelText(/assignment id/i), 'asgn_2')
    await userEvent.click(screen.getByRole('button', { name: /release/i }))

    const totpInput = await screen.findByLabelText(/totp/i)
    await userEvent.type(totpInput, '654321')
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))

    expect(await screen.findByText(/released/i)).toBeTruthy()

    const releaseCalls = calls.filter((c) => c.url.includes('/ops/records/asgn_2/release'))
    expect(releaseCalls.length).toBe(2)
    const keyFirst = headerValue(releaseCalls[0]!, 'Idempotency-Key')
    expect(keyFirst).toBeTruthy()
    expect(headerValue(releaseCalls[1]!, 'Idempotency-Key')).toBe(keyFirst)
  })
})

describe('VendorSuspendButton', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('posts to /ops/vendors/:id/suspend with NO body once an immediate 200 is returned', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/vendors/vndr_1/suspend')) return jsonResponse({ deduped: false })
        return jsonResponse({})
      }),
    )

    render(withProviders(<VendorSuspendButton />))

    await userEvent.type(screen.getByLabelText(/vendor id/i), 'vndr_1')
    await userEvent.click(screen.getByRole('button', { name: /suspend/i }))

    expect(await screen.findByText(/suspended/i)).toBeTruthy()

    const call = calls.find((c) => c.url.includes('/ops/vendors/vndr_1/suspend'))
    expect(call).toBeTruthy()
    expect(call!.init.method).toBe('POST')
    expect(headerValue(call!, 'Idempotency-Key')).toBeTruthy()
    expect(call!.init.body).toBeUndefined()
  })

  // check 3 (not-an-authority): the button renders enabled regardless of any
  // client-side notion of permission (there is no scope field on the display
  // principal to gate on, S24/T14: the SPA never holds an authorization
  // model). Even so, when the edge denies the action both before AND after a
  // successful step-up, the SPA surfaces the denial and never renders a
  // success/granted state. Disabling a control client-side would be
  // cosmetic at best; this proves it is not load-bearing either way.
  it('check 3: the control is enabled, but a 403 that persists after step-up is surfaced, never granted client-side', async () => {
    const calls: Call[] = []
    let suspendCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/vendors/vndr_2/suspend')) {
          suspendCallCount += 1
          return jsonResponse(null, 403) // denied both before AND after step-up
        }
        if (url.includes('/session/stepup')) return jsonResponse({ accessToken: 'tok-2' })
        return jsonResponse({})
      }),
    )

    render(withProviders(<VendorSuspendButton />))

    const button = screen.getByRole('button', { name: /suspend/i })
    expect((button as HTMLButtonElement).disabled).toBe(false)

    await userEvent.type(screen.getByLabelText(/vendor id/i), 'vndr_2')
    await userEvent.click(button)

    const totpInput = await screen.findByLabelText(/totp/i)
    await userEvent.type(totpInput, '111111')
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText(/suspended/i)).toBeNull()
    expect(suspendCallCount).toBe(2) // one attempt, one retry after step-up: no further loop
  })
})
