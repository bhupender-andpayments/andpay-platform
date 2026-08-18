import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { EmbeddedUploadCard } from '../../src/components/EmbeddedUploadCard.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// Task 7: the batch-scoped compact upload flows that Task 8 mounts on the
// batch detail page. Same endpoints as the full /uploads/* pages, but no
// DataGrid of preview rows: a count summary, PerRowErrors for invalid rows,
// and a link back to the full page for deep inspection.

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

function formValue(call: Call, key: string): string | null {
  const form = call.init.body as FormData
  const v = form.get(key)
  return typeof v === 'string' ? v : v === null ? null : '(file)'
}

function renderCard(props: {
  kind: 'return' | 'courier-status' | 'activation'
  batchId?: string
  batchAsgnIds?: ReadonlySet<string>
  onDone?: () => void
}) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <EmbeddedUploadCard {...props} />
      </AuthProvider>
    </MemoryRouter>,
  )
}

function makeFile(name: string, content = 'a,b\n1,2\n'): File {
  return new File([content], name, { type: 'text/csv' })
}

async function pickFile(inputId: string, file: File): Promise<void> {
  const input = document.getElementById(inputId) as HTMLInputElement
  await userEvent.upload(input, file)
}

// Same drive-it-like-an-operator idiom as test/helpers/pickers.ts's
// pickOption, but waits for the option to actually appear before clicking:
// the courier list here loads from a real async fetch (getVendors), so the
// popover can open before its options have arrived.
async function pickCourier(triggerText: RegExp, optionLabel: string): Promise<void> {
  await userEvent.click(screen.getByText(triggerText))
  const listbox = await screen.findByRole('listbox')
  const option = await within(listbox).findByRole('option', { name: optionLabel })
  await userEvent.click(option)
}

describe('EmbeddedUploadCard', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('return kind: previews then commits with an Idempotency-Key, renders paired/shipment counts, and fires onDone', async () => {
    const calls: Call[] = []
    const onDone = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/uploads/return/preview')) {
          return jsonResponse({
            validRows: [
              { asgnId: 'asgn_1', deviceSerial: 'DEV-1', awb: 'AWB1' },
              { asgnId: 'asgn_2', deviceSerial: 'DEV-2', awb: 'AWB2' },
            ],
            invalidRows: [{ rowNo: 4, message: 'Missing AWB' }],
            structuralErrors: [],
          })
        }
        if (url.includes('/ops/uploads/return')) {
          return jsonResponse({
            pairedUnitIds: ['DEV-1', 'DEV-2'],
            quarantined: 0,
            shptIds: ['shpt_1'],
            collateralLinked: 0,
            deduped: false,
            invalidRows: [],
          })
        }
        throw new Error(`unexpected url ${url}`)
      }),
    )

    renderCard({ kind: 'return', onDone })

    await pickFile('embedded-upload-return', makeFile('return.csv'))

    expect(await screen.findByText(/2 rows ready/i)).toBeTruthy()
    // The summary line and the PerRowErrors breakdown below it must agree on
    // one word for the same rows: both say "invalid", not "unreadable" beside
    // "Invalid" (2026-08-18 fix).
    expect(screen.getByText(/1 invalid/i)).toBeTruthy()
    expect(screen.getByText('Invalid')).toBeTruthy()
    const previewCall = calls.find((c) => c.url.includes('/ops/uploads/return/preview'))
    expect(previewCall).toBeTruthy()

    const commitButton = screen.getByRole('button', { name: /commit/i })
    expect((commitButton as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(commitButton)

    const commitCall = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.endsWith('/ops/uploads/return'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(commitCall.init.method).toBe('POST')
    expect(headerValue(commitCall, 'Idempotency-Key')).toBeTruthy()

    expect(await screen.findByText(/2 device\(s\) paired/i)).toBeTruthy()
    expect(screen.getByText(/1 shipment\(s\) created/i)).toBeTruthy()
    expect(onDone).toHaveBeenCalledTimes(1)

    expect(screen.getByRole('link', { name: /open full upload page/i }).getAttribute('href')).toBe('/uploads/return')
  })

  it('return kind with batchAsgnIds: shows how many of the previewed rows target this batch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/preview')) {
          return jsonResponse({
            validRows: [
              { asgnId: 'asgn_1', deviceSerial: 'DEV-1', awb: 'AWB1' },
              { asgnId: 'asgn_2', deviceSerial: 'DEV-2', awb: 'AWB2' },
              { asgnId: 'asgn_other', deviceSerial: 'DEV-3', awb: 'AWB3' },
            ],
            invalidRows: [],
            structuralErrors: [],
          })
        }
        return jsonResponse({})
      }),
    )

    renderCard({ kind: 'return', batchId: 'btch_1', batchAsgnIds: new Set(['asgn_1', 'asgn_2']) })
    await pickFile('embedded-upload-return', makeFile('return.csv'))

    expect(await screen.findByText(/3 rows in this file, 2 target this batch/i)).toBeTruthy()
    // Commit is never blocked by batch scope.
    expect((screen.getByRole('button', { name: /commit/i }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('courier kind: commit stays disabled until a courier vendor is chosen, then posts multipart with courierVndrId', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/vendors')) {
          return jsonResponse([
            { id: 'vndr_courier_1', type: 'COURIER', displayName: 'Speedy Couriers', status: 'ACTIVE', courierCode: 'SPD', createdAt: '', updatedAt: '' },
            { id: 'vndr_print_1', type: 'PRINT', displayName: 'Print Co', status: 'ACTIVE', courierCode: null, createdAt: '', updatedAt: '' },
          ])
        }
        if (url.includes('/ops/uploads/courier-status')) {
          return jsonResponse({
            fileId: 'file_1',
            advanced: 3,
            trailOnly: 1,
            quarantined: 1,
            invalid: 0,
            invalidRows: [],
            deduped: false,
          })
        }
        throw new Error(`unexpected url ${url}`)
      }),
    )

    renderCard({ kind: 'courier-status' })

    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/vendors'))).toBe(true)
    })
    await pickFile('embedded-upload-courier-status', makeFile('courier.csv'))

    const commitButton = screen.getByRole('button', { name: /commit/i })
    expect((commitButton as HTMLButtonElement).disabled).toBe(true)

    await pickCourier(/select a courier/i, 'Speedy Couriers')

    expect((screen.getByRole('button', { name: /commit/i }) as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: /commit/i }))

    const commitCall = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/ops/uploads/courier-status'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(formValue(commitCall, 'courierVndrId')).toBe('vndr_courier_1')
    expect(await screen.findByText(/3 advanced/i)).toBeTruthy()
  })

  it('activation kind: straight commit, renders per-row results reasons', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return jsonResponse({
          activated: 1,
          invalid: 1,
          invalidRows: [{ rowNo: 2, errors: ['missing_status'] }],
          results: [
            { deviceId: 'DEV-1', dispatchId: 'asgn_1', activated: true, reason: null },
            { deviceId: 'DEV-2', dispatchId: 'asgn_2', activated: false, reason: 'not-activatable' },
          ],
        })
      }),
    )

    renderCard({ kind: 'activation' })
    await pickFile('embedded-upload-activation', makeFile('activation.csv'))

    const commitButton = screen.getByRole('button', { name: /commit/i })
    expect((commitButton as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(commitButton)

    const commitCall = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/ops/uploads/activation'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(headerValue(commitCall, 'Idempotency-Key')).toBeTruthy()

    expect(await screen.findByText(/1 activated/i)).toBeTruthy()
    expect(screen.getByText(/collateral does not activate/i)).toBeTruthy()
  })
})
