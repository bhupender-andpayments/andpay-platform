import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { QueuesPage } from '../../src/features/queues/QueuesPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The confirmed ops-edge contract this task is grounded against:
//   GET  /ops/quarantine[?includeResolved=true]        -> QuarantineRowView[]
//   GET  /ops/exceptions/intake[?includeResolved=true]  -> IntakeExceptionView[]
//   GET  /ops/exceptions/status[?includeResolved=true]  -> CourierStatusExceptionView[]
//   POST /ops/quarantine/:id/resolve         { correctedRow: BankRequestRow }  (BankRequestRow.branchCode
//     is now MANDATORY at ingest, services/tms/src/ingest.ts requestRowRejectReason
//     'missing_branch_code'; resolveQuarantineRow re-drives the same ingest, so a
//     re-keyed correction MUST carry it or the row bounces straight back to
//     quarantine)
//   POST /ops/intake-exceptions/:id/resolve  { correctedSheet: IntakeSheet }   (raw exceptionId, unblocked)
//   POST /ops/status-exceptions/:id/resolve  { shptId, status, courierTimestamp } (G-SHPT resolved by
//     commit 354aa76: GET /ops/exceptions/status now LEFT JOINs shpt.awb = subjectRef and returns
//     shptId: string | null. A row with a non-null shptId is resolvable (the operator picks a status +
//     courier timestamp; shptId itself comes ONLY from the row, never typed). A row with a null shptId
//     (unknown_awb, no matching shipment) stays permanently gated: disabled control, no id ever sent)
// (apps/ops-edge/src/ops-read.controller.ts, apps/ops-edge/src/ops.controller.ts).
// Every resolve test asserts the CORRECTED payload shape and an
// Idempotency-Key header, not just an id, per the task's real edge contract.

interface Call {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function parseBody(call: Call): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>
}

function headerValue(call: Call, name: string): string | null {
  const headers = call.init.headers as Record<string, string>
  return headers[name] ?? null
}

describe('QueuesPage', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders the quarantine queue, includeResolved toggles the request, and resolve posts the corrected row (with branchCode) and an Idempotency-Key', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/quarantine/qr-1/resolve')) {
          return jsonResponse({ deduped: false, outcome: 'accepted' })
        }
        if (url.includes('/ops/quarantine')) {
          return jsonResponse([
            {
              id: 'qr-1',
              fileId: 'file-1',
              rowNo: 3,
              reasonCode: 'missing_branch_code',
              createdAt: '2026-07-01T00:00:00.000Z',
              resolvedAt: null,
              resolvedByActor: null,
            },
          ])
        }
        return jsonResponse([])
      }),
    )

    render(
      <MemoryRouter
        initialEntries={['/queues/quarantine']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          {/* The active tab is now a ROUTE PARAM, not local state, so the page
              has to be mounted under a matching route. Rendered bare it reads an
              undefined tab and redirects to the canonical first tab, which in a
              router with no routes renders nothing at all. Clicking a tab
              navigates, which is exactly what these tests then exercise. */}
          <Routes>
            <Route path="/queues/:tab" element={<QueuesPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('file-1')).toBeTruthy()
    expect(screen.getByText('Missing Branch Code')).toBeTruthy()

    // includeResolved toggle changes the request.
    const getCallsBefore = calls.filter((c) => c.url.includes('/ops/quarantine') && !c.url.includes('resolve')).length
    await userEvent.click(screen.getByLabelText(/show resolved/i))
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/quarantine?includeResolved=true'))).toBe(true)
    })
    const getCallsAfterToggle = calls.filter((c) => c.url.includes('/ops/quarantine') && !c.url.includes('resolve')).length
    expect(getCallsAfterToggle).toBeGreaterThan(getCallsBefore)

    // Resolve: fill every correction field including the now-mandatory branch
    // code, submit, and assert the real BankRequestRow shape (with branchCode)
    // rode the POST body, not a bare id.
    await userEvent.click(screen.getByRole('button', { name: /resolve quarantine row qr-1/i }))
    await userEvent.type(screen.getByLabelText(/bank merchant reference/i), 'BMR-1')
    await userEvent.type(screen.getByLabelText(/display name/i), 'Acme Store')
    await userEvent.type(screen.getByLabelText(/legal name/i), 'Acme Pvt Ltd')
    await userEvent.type(screen.getByLabelText(/^mcc$/i), '5411')
    await userEvent.type(screen.getByLabelText(/registered address/i), '1 Market St')
    await userEvent.type(screen.getByLabelText(/bank reference code/i), 'BRC-1')
    await userEvent.type(screen.getByLabelText(/^product type$/i), 'soundbox')
    await userEvent.type(screen.getByLabelText(/vpa value/i), 'acme@bank')
    await userEvent.type(screen.getByLabelText(/qr value/i), 'qr-data')
    await userEvent.type(screen.getByLabelText(/ship-to address/i), '2 Ship Ln')
    await userEvent.type(screen.getByLabelText(/contact name/i), 'Jane Doe')
    await userEvent.type(screen.getByLabelText(/mobile/i), '9999999999')
    await userEvent.type(screen.getByLabelText(/branch code/i), 'BR-100')
    await userEvent.click(screen.getByLabelText(/soundbox/i))

    const getCallsBeforeResolve = calls.filter((c) => c.url.includes('/ops/quarantine') && !c.url.includes('resolve')).length
    await userEvent.click(screen.getByRole('button', { name: /submit correction/i }))

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/quarantine/qr-1/resolve'))).toBe(true)
    })
    const resolveCall = calls.find((c) => c.url.includes('/ops/quarantine/qr-1/resolve'))
    expect(resolveCall).toBeTruthy()
    expect(headerValue(resolveCall!, 'Idempotency-Key')).toBeTruthy()
    const body = parseBody(resolveCall!)
    const correctedRow = body.correctedRow as Record<string, unknown>
    expect(correctedRow.fileId).toBe('file-1')
    expect(correctedRow.rowNo).toBe(3)
    expect(correctedRow.bankMerchantReference).toBe('BMR-1')
    expect(correctedRow.displayName).toBe('Acme Store')
    expect(correctedRow.legalName).toBe('Acme Pvt Ltd')
    expect(correctedRow.mcc).toBe('5411')
    expect(correctedRow.registeredAddress).toBe('1 Market St')
    expect(correctedRow.bankReferenceCode).toBe('BRC-1')
    expect(correctedRow.productType).toBe('soundbox')
    expect(correctedRow.vpaValue).toBe('acme@bank')
    expect(correctedRow.qrValue).toBe('qr-data')
    expect(correctedRow.shipToAddress).toBe('2 Ship Ln')
    expect(correctedRow.contactName).toBe('Jane Doe')
    expect(correctedRow.mobile).toBe('9999999999')
    expect(correctedRow.branchCode).toBe('BR-100')
    expect(correctedRow.soundbox).toBe(true)
    expect(correctedRow.standeeCount).toBe(0)
    expect(correctedRow.stickerCount).toBe(0)

    // The list refreshes after a successful resolve.
    await waitFor(() => {
      const after = calls.filter((c) => c.url.includes('/ops/quarantine') && !c.url.includes('resolve')).length
      expect(after).toBeGreaterThan(getCallsBeforeResolve)
    })
  })

  it('renders intake exceptions and resolves with a correctedSheet including a dynamically added row (raw exceptionId, unblocked)', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/intake-exceptions/ie-1/resolve')) {
          return jsonResponse({ deduped: false, result: { createdUnitIds: ['u-1'], quarantined: 0, deduped: false } })
        }
        if (url.includes('/ops/exceptions/intake')) {
          return jsonResponse([
            {
              id: 'ie-1',
              vndrId: 'vndr-1',
              fileId: 'file-2',
              rowRef: 'row-5',
              reasonCode: 'duplicate_serial',
              createdAt: '2026-07-01T00:00:00.000Z',
              resolvedAt: null,
              resolvedByActor: null,
            },
          ])
        }
        return jsonResponse([])
      }),
    )

    render(
      <MemoryRouter
        initialEntries={['/queues/quarantine']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          {/* The active tab is now a ROUTE PARAM, not local state, so the page
              has to be mounted under a matching route. Rendered bare it reads an
              undefined tab and redirects to the canonical first tab, which in a
              router with no routes renders nothing at all. Clicking a tab
              navigates, which is exactly what these tests then exercise. */}
          <Routes>
            <Route path="/queues/:tab" element={<QueuesPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )

    await userEvent.click(screen.getByRole('button', { name: /intake exceptions/i }))
    expect(await screen.findByText('row-5')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /resolve intake exception ie-1/i }))
    // fileId and vndrId are pre-filled from the exception row.
    expect((screen.getByLabelText(/file id/i) as HTMLInputElement).value).toBe('file-2')
    expect((screen.getByLabelText(/vendor id/i) as HTMLInputElement).value).toBe('vndr-1')
    await userEvent.type(screen.getByLabelText(/work queue/i), 'wq-1')

    await userEvent.click(screen.getByRole('button', { name: /add serialized row/i }))
    await userEvent.type(screen.getByLabelText(/device serial/i), 'SER-123')
    await userEvent.type(screen.getByLabelText(/^product type$/i), 'soundbox')
    // deviceQr textarea defaults to '{}', left as-is.

    await userEvent.click(screen.getByRole('button', { name: /submit correction/i }))

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/intake-exceptions/ie-1/resolve'))).toBe(true)
    })
    const resolveCall = calls.find((c) => c.url.includes('/ops/intake-exceptions/ie-1/resolve'))
    expect(resolveCall).toBeTruthy()
    expect(headerValue(resolveCall!, 'Idempotency-Key')).toBeTruthy()
    const body = parseBody(resolveCall!)
    const correctedSheet = body.correctedSheet as Record<string, unknown>
    expect(correctedSheet.fileId).toBe('file-2')
    expect(correctedSheet.vndrId).toBe('vndr-1')
    expect(correctedSheet.workQueue).toBe('wq-1')
    expect(correctedSheet.rows).toEqual([
      { kind: 'SERIALIZED', deviceSerial: 'SER-123', productType: 'soundbox', deviceQr: {} },
    ])
  })

  it('renders status exceptions with an unknown_awb row (null shptId) GATED: no matching shipment, so it never sends a resolve request', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/status-exceptions/')) {
          // Should never be hit; fail loudly if the gate is bypassed.
          return jsonResponse({ deduped: false, outcome: 'corrected' })
        }
        if (url.includes('/ops/exceptions/status')) {
          return jsonResponse([
            {
              id: 'se-1',
              vndrId: 'vndr-1',
              channel: 'sms',
              subjectRef: 'subj-1',
              fileId: null,
              rowRef: null,
              reasonCode: 'unknown_awb',
              createdAt: '2026-07-01T00:00:00.000Z',
              resolvedAt: null,
              resolvedByActor: null,
              shptId: null,
            },
          ])
        }
        return jsonResponse([])
      }),
    )

    render(
      <MemoryRouter
        initialEntries={['/queues/quarantine']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          {/* The active tab is now a ROUTE PARAM, not local state, so the page
              has to be mounted under a matching route. Rendered bare it reads an
              undefined tab and redirects to the canonical first tab, which in a
              router with no routes renders nothing at all. Clicking a tab
              navigates, which is exactly what these tests then exercise. */}
          <Routes>
            <Route path="/queues/:tab" element={<QueuesPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )

    await userEvent.click(screen.getByRole('button', { name: /status exceptions/i }))
    expect(await screen.findByText('subj-1')).toBeTruthy()
    // A null fileId/rowRef render as a neutral marker, not "null".
    expect(screen.queryByText('null')).toBeNull()

    // The Resolve control is present but disabled, with a title explaining
    // why (no matching shipment), and carries no working click handler that
    // could ever open a form capable of sending a bad id.
    const resolveButton = screen.getByRole('button', { name: /resolve status exception se-1/i }) as HTMLButtonElement
    expect(resolveButton.disabled).toBe(true)
    expect(resolveButton.title).toMatch(/no matching shipment/i)
    await userEvent.click(resolveButton)

    // No form ever appears, and above all: no resolve request is ever sent.
    expect(screen.queryByRole('button', { name: /submit correction/i })).toBeNull()
    expect(calls.some((c) => c.url.includes('/ops/status-exceptions/'))).toBe(false)
  })

  it('resolves a matched status exception (non-null shptId): the Resolve control is enabled and posts the raw exceptionId + the row wire shptId', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/status-exceptions/se-2/resolve')) {
          return jsonResponse({ deduped: false, outcome: 'corrected' })
        }
        if (url.includes('/ops/exceptions/status')) {
          return jsonResponse([
            {
              id: 'se-2',
              vndrId: 'vndr-1',
              channel: 'WEBHOOK',
              subjectRef: 'AWB-999',
              fileId: null,
              rowRef: null,
              reasonCode: 'courier_unassigned',
              createdAt: '2026-07-01T00:00:00.000Z',
              resolvedAt: null,
              resolvedByActor: null,
              shptId: 'shpt_abc123',
            },
          ])
        }
        return jsonResponse([])
      }),
    )

    render(
      <MemoryRouter
        initialEntries={['/queues/quarantine']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          {/* The active tab is now a ROUTE PARAM, not local state, so the page
              has to be mounted under a matching route. Rendered bare it reads an
              undefined tab and redirects to the canonical first tab, which in a
              router with no routes renders nothing at all. Clicking a tab
              navigates, which is exactly what these tests then exercise. */}
          <Routes>
            <Route path="/queues/:tab" element={<QueuesPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )

    await userEvent.click(screen.getByRole('button', { name: /status exceptions/i }))
    expect(await screen.findByText('AWB-999')).toBeTruthy()

    const resolveButton = screen.getByRole('button', { name: /resolve status exception se-2/i }) as HTMLButtonElement
    expect(resolveButton.disabled).toBe(false)
    await userEvent.click(resolveButton)

    // A status + courier-timestamp form appears; no shptId input exists
    // anywhere (it is never typed).
    expect(screen.queryByLabelText(/shipment id/i)).toBeNull()
    await userEvent.selectOptions(screen.getByLabelText(/^status$/i), 'DELIVERED')
    await userEvent.type(screen.getByLabelText(/courier timestamp/i), '2026-08-05T10:00')

    const getCallsBeforeResolve = calls.filter((c) => c.url.includes('/ops/exceptions/status')).length
    await userEvent.click(screen.getByRole('button', { name: /submit correction/i }))

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/status-exceptions/se-2/resolve'))).toBe(true)
    })
    const resolveCall = calls.find((c) => c.url.includes('/ops/status-exceptions/se-2/resolve'))
    expect(resolveCall).toBeTruthy()
    expect(headerValue(resolveCall!, 'Idempotency-Key')).toBeTruthy()
    const body = parseBody(resolveCall!)
    expect(body.shptId).toBe('shpt_abc123')
    expect(body.status).toBe('DELIVERED')
    expect(body.courierTimestamp).toBe('2026-08-05T10:00')

    // The list refreshes after a successful resolve.
    await waitFor(() => {
      const after = calls.filter((c) => c.url.includes('/ops/exceptions/status')).length
      expect(after).toBeGreaterThan(getCallsBeforeResolve)
    })
  })
})
