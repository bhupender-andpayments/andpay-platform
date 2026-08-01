import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { BatchPage } from '../../src/features/operations/BatchPage.js'
import { StatusCorrectionForm } from '../../src/features/operations/StatusCorrectionForm.js'
import { RecomposeForm } from '../../src/features/operations/RecomposeForm.js'
import { HoldButton } from '../../src/features/operations/HoldButton.js'
import { DispatchHistoryPage } from '../../src/features/operations/DispatchHistoryPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The confirmed ops-edge contract (task 14 brief, grounded against
// apps/ops-edge/src/ops.controller.ts):
//   POST /ops/batches/trigger        { tenantWire, programWire } -> { btchId } | null
//   POST /ops/shipments/:id/correct  { status, courierTimestamp } -> { deduped, outcome }
//   POST /ops/artifacts/recompose    { asgnId, artifactType, requestedShipTo? } -> { deduped, artifactId }
//   POST /ops/records/:asgnId/hold   (no body) -> { deduped }
// None of these four are step-up-gated. Dispatch history reuses
// getReport('soundbox-delivery', filters) (Task 10), no new route.

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

describe('BatchPage', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

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
})

describe('StatusCorrectionForm', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('posts a known status correction to /ops/shipments/:id/correct with an Idempotency-Key', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/shipments/shpt_1/correct')) {
          return jsonResponse({ deduped: false, outcome: 'advanced' })
        }
        return jsonResponse({})
      }),
    )

    render(withProviders(<StatusCorrectionForm />))

    await userEvent.type(screen.getByLabelText(/shipment id/i), 'shpt_1')
    await userEvent.selectOptions(screen.getByLabelText(/status/i), 'DELIVERED')
    await userEvent.type(screen.getByLabelText(/courier timestamp/i), '2026-08-01T10:00')
    await userEvent.click(screen.getByRole('button', { name: /submit|correct/i }))

    expect(await screen.findByText(/advanced/i)).toBeTruthy()

    const call = calls.find((c) => c.url.includes('/ops/shipments/shpt_1/correct'))
    expect(call).toBeTruthy()
    expect(headerValue(call!, 'Idempotency-Key')).toBeTruthy()
    const body = parseBody(call!)
    expect(body.status).toBe('DELIVERED')
    expect(body.courierTimestamp).toBe('2026-08-01T10:00')
  })

  it('the status dropdown offers only the known courier statuses', () => {
    render(withProviders(<StatusCorrectionForm />))
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
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

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
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

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
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('renders soundbox-delivery report rows via getReport', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return jsonResponse({
          rows: [{ dispatchId: 'asgn_1', bankCode: 'HDFC', awb: 'AWB-1' }],
          watermark: { asOf: '2026-08-01T00:00:00.000Z', perTopic: {} },
        })
      }),
    )

    render(withProviders(<DispatchHistoryPage />))

    expect(await screen.findByText('AWB-1')).toBeTruthy()
    const call = calls.find((c) => c.url.includes('/ops/reports/soundbox-delivery'))
    expect(call).toBeTruthy()
    expect(call!.init.method).toBe('GET')
  })
})
