import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { BankUploadPage } from '../../src/features/uploads/BankUploadPage.js'
import { DamageUploadPage } from '../../src/features/uploads/DamageUploadPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The confirmed ops-edge contract (task 13 brief, grounded against
// apps/ops-edge/src/ops.controller.ts's uploadBank/uploadDamage and
// services/tms/src/ingest.ts / damage.ts):
//   POST /ops/uploads/bank   { rows: BankRequestRow[] } -> { accepted, quarantined, duplicate }
//   POST /ops/uploads/damage { rows: BankDamageRow[] }  -> { replaced, quarantined, duplicate }
// Body is plain JSON (NOT multipart): the SPA parses the file to typed rows
// client-side (parseSheet.ts) and posts them. Both need Idempotency-Key,
// neither is step-up-gated.

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

const BANK_CSV = [
  'bankMerchantReference,displayName,legalName,mcc,registeredAddress,bankReferenceCode,productType,vpaValue,qrValue,soundbox,standeeCount,stickerCount,shipToAddress,contactName,mobile,vpaHint',
  'BMR-1,Acme Store,Acme Pvt Ltd,5411,1 Market St,BRC-1,soundbox,acme@bank,qr-data-1,true,1,2,2 Ship Ln,Jane Doe,9999999999,hint-1',
  'BMR-2,Beta Store,Beta Pvt Ltd,5412,2 Market St,BRC-2,soundbox,beta@bank,qr-data-2,yes,0,1,3 Ship Ln,John Roe,8888888888,',
  'BMR-3,,,,,,,,,false,0,0,,,,',
  'BMR-4,,,,,,,,,false,0,0,,,,',
  'BMR-5,,,,,,,,,false,0,0,,,,',
].join('\n')

const DAMAGE_CSV = [
  'tenantReference,vpaValue,damageReason,bankRemarks,shipToAddress',
  'BRC-1,acme@bank,cracked-screen,replace ASAP,2 Ship Ln',
  'BRC-2,beta@bank,water-damage,replace,3 Ship Ln',
  ',,,,',
].join('\n')

function makeFile(content: string, name: string, type = 'text/csv'): File {
  return new File([content], name, { type })
}

function makeOversizedFile(): File {
  // 6 MiB of zero bytes, well past the 5 MiB cap. No need for real CSV
  // content since the size check must reject before any parse/read.
  return new File([new Uint8Array(6 * 1024 * 1024)], 'huge.csv', { type: 'text/csv' })
}

describe('uploads', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('bank upload: a mixed-validity file posts JSON rows with an Idempotency-Key and renders the accepted/quarantined breakdown with a quarantine link', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/uploads/bank')) {
          return jsonResponse({ accepted: 3, quarantined: 2, duplicate: 0 })
        }
        return jsonResponse({})
      }),
    )

    render(
      <MemoryRouter>
        <AuthProvider>
          <BankUploadPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    const input = screen.getByLabelText(/bank request file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile(BANK_CSV, 'bank.csv'))

    expect(await screen.findByText('3')).toBeTruthy()
    // The quarantined <dd> also contains the queue Link's text, so an exact
    // getByText('2') would not match; check the dd's content directly.
    const quarantinedDd = screen.getByText('Quarantined').nextElementSibling as HTMLElement
    expect(quarantinedDd.textContent).toContain('2')
    expect(screen.getByRole('link', { name: /view in quarantine queue/i })).toBeTruthy()

    const call = calls.find((c) => c.url.includes('/ops/uploads/bank'))
    expect(call).toBeTruthy()
    expect(headerValue(call!, 'Idempotency-Key')).toBeTruthy()
    const body = parseBody(call!)
    const rows = body.rows as Record<string, unknown>[]
    expect(rows).toHaveLength(5)
    expect(rows[0]!.rowNo).toBe(1)
    expect(rows[0]!.fileId).toEqual(rows[1]!.fileId) // one client fileId for the whole upload
    expect(typeof rows[0]!.fileId).toBe('string')
    expect(rows[0]!.bankMerchantReference).toBe('BMR-1')
    expect(rows[0]!.displayName).toBe('Acme Store')
    expect(rows[0]!.legalName).toBe('Acme Pvt Ltd')
    expect(rows[0]!.mcc).toBe('5411')
    expect(rows[0]!.registeredAddress).toBe('1 Market St')
    expect(rows[0]!.bankReferenceCode).toBe('BRC-1')
    expect(rows[0]!.productType).toBe('soundbox')
    expect(rows[0]!.vpaValue).toBe('acme@bank')
    expect(rows[0]!.qrValue).toBe('qr-data-1')
    expect(rows[0]!.soundbox).toBe(true)
    expect(rows[0]!.standeeCount).toBe(1)
    expect(rows[0]!.stickerCount).toBe(2)
    expect(rows[0]!.shipToAddress).toBe('2 Ship Ln')
    expect(rows[0]!.contactName).toBe('Jane Doe')
    expect(rows[0]!.mobile).toBe('9999999999')
    expect(rows[0]!.vpaHint).toBe('hint-1')
    // yes -> true boolean coercion.
    expect(rows[1]!.soundbox).toBe(true)
    expect(rows[1]!.rowNo).toBe(2)
    // A blank-cell row still gets numeric/boolean coercion, not left as text.
    expect(rows[2]!.soundbox).toBe(false)
    expect(rows[2]!.standeeCount).toBe(0)
  })

  it('bank upload: a file over 5 MiB is rejected client-side and never posted', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ accepted: 0, quarantined: 0, duplicate: 0 }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MemoryRouter>
        <AuthProvider>
          <BankUploadPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    const input = screen.getByLabelText(/bank request file/i) as HTMLInputElement
    await userEvent.upload(input, makeOversizedFile())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/5 MiB/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('damage upload: a mixed-validity file posts JSON rows with an Idempotency-Key and renders the replaced/quarantined breakdown with a quarantine link', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/uploads/damage')) {
          return jsonResponse({ replaced: 2, quarantined: 1, duplicate: 0 })
        }
        return jsonResponse({})
      }),
    )

    render(
      <MemoryRouter>
        <AuthProvider>
          <DamageUploadPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    const input = screen.getByLabelText(/damage report file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile(DAMAGE_CSV, 'damage.csv'))

    expect(await screen.findByText('2')).toBeTruthy()
    const quarantinedDd = screen.getByText('Quarantined').nextElementSibling as HTMLElement
    expect(quarantinedDd.textContent).toContain('1')
    expect(screen.getByRole('link', { name: /view in quarantine queue/i })).toBeTruthy()

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/uploads/damage'))).toBe(true)
    })
    const call = calls.find((c) => c.url.includes('/ops/uploads/damage'))!
    expect(headerValue(call, 'Idempotency-Key')).toBeTruthy()
    const body = parseBody(call)
    const rows = body.rows as Record<string, unknown>[]
    expect(rows).toHaveLength(3)
    expect(rows[0]!.rowNo).toBe(1)
    expect(rows[0]!.fileId).toEqual(rows[1]!.fileId)
    expect(rows[0]!.tenantReference).toBe('BRC-1')
    expect(rows[0]!.vpaValue).toBe('acme@bank')
    expect(rows[0]!.damageReason).toBe('cracked-screen')
    expect(rows[0]!.bankRemarks).toBe('replace ASAP')
    expect(rows[0]!.shipToAddress).toBe('2 Ship Ln')
  })

  it('damage upload: a file over 5 MiB is rejected client-side and never posted', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ replaced: 0, quarantined: 0, duplicate: 0 }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MemoryRouter>
        <AuthProvider>
          <DamageUploadPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    const input = screen.getByLabelText(/damage report file/i) as HTMLInputElement
    await userEvent.upload(input, makeOversizedFile())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/5 MiB/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
