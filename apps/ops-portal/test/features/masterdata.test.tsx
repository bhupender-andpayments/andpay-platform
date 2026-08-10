import type { ReactElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { MasterDataPage } from '../../src/features/masterdata/MasterDataPage.js'
import { VendorRegistryPage } from '../../src/features/masterdata/VendorRegistryPage.js'
import { CourierMasterPage } from '../../src/features/masterdata/CourierMasterPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The confirmed ops-edge contract this task is grounded against (all FIVE
// reads are class-3 guard-only: no per-op D2 authorize, no 6e, check 3):
//   GET /ops/vendors          -> VendorRow[] (platform-only, all types)
//   GET /ops/bank-masters     -> BankMasterRow[]
//   GET /ops/damage-reasons   -> DamageReasonRow[]
//   GET /ops/batching-config  -> BatchingConfigRow[]
// The courier master is NOT a separate route: it is /ops/vendors filtered
// client-side to type === 'COURIER' (existing CourierMasterPage precedent).
// FR-11 (admin console: vendor create/suspend, damage-reason
// create/activate/deactivate, batching-config SET, bank-master create/edit)
// is deferred (ratified L9): every view here is READ-ONLY, so this suite
// asserts both real data rendering AND the absence of any write control.

interface Call {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const MIXED_VENDORS = [
  {
    id: 'v-1',
    type: 'MANUFACTURER',
    displayName: 'Acme Devices',
    status: 'ACTIVE',
    courierCode: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  },
  {
    id: 'v-2',
    type: 'PRINT',
    displayName: 'Print Co',
    status: 'ACTIVE',
    courierCode: null,
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
  },
  {
    id: 'v-3',
    type: 'COURIER',
    displayName: 'Speedy Couriers',
    status: 'ACTIVE',
    courierCode: 'SPD',
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
  },
]

const BANK_MASTERS = [
  {
    tnntId: 'tnnt_bank1000000000000000000',
    displayName: 'First National Bank',
    bankReferenceCode: 'FNB',
    status: 'ACTIVE',
    address1: null,
    address2: null,
    address3: null,
    city: 'Mumbai',
    district: null,
    country: 'IN',
    pin: null,
    mobile: '9900011122',
    email: 'ops@fnb.example',
  },
]

const DAMAGE_REASONS = [
  { id: 'dr-1', code: 'WATER', label: 'Water damage', active: true, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-02T00:00:00.000Z' },
  { id: 'dr-2', code: 'CRACK', label: 'Cracked screen', active: false, createdAt: '2026-06-03T00:00:00.000Z', updatedAt: '2026-06-04T00:00:00.000Z' },
]

const BATCHING_CONFIGS = [
  {
    id: 'bc-1',
    scope: 'GLOBAL',
    tenantWire: null,
    programWire: null,
    minLotSize: 50,
    maxWaitSeconds: 3600,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
  },
  {
    id: 'bc-2',
    scope: 'TENANT',
    tenantWire: 'tnnt_bank1000000000000000000',
    programWire: null,
    minLotSize: 25,
    maxWaitSeconds: 1800,
    createdAt: '2026-05-03T00:00:00.000Z',
    updatedAt: '2026-05-04T00:00:00.000Z',
  },
]

function stubAllReads(calls: Call[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = { method: 'GET' }) => {
      calls.push({ url, init })
      if (url.includes('/ops/vendors')) return jsonResponse(MIXED_VENDORS)
      if (url.includes('/ops/bank-masters')) return jsonResponse(BANK_MASTERS)
      if (url.includes('/ops/damage-reasons')) return jsonResponse(DAMAGE_REASONS)
      if (url.includes('/ops/batching-config')) return jsonResponse(BATCHING_CONFIGS)
      return jsonResponse([])
    }),
  )
}

function renderPage(ui: ReactElement) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  )
}

// Any control whose accessible name suggests a mutation. The Tabs primitive's
// own switch buttons ("Vendor Registry", "Courier Master", "Bank Masters",
// "Damage Reasons", "Batching Config") never match this, so this pattern can
// safely be checked against every button on the page.
const WRITE_CONTROL_PATTERN = /\b(add|create|new|edit|delete|remove|suspend|activate|deactivate|set|save|submit)\b/i

describe('master data views', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('VendorRegistryPage lists ALL vendors regardless of type', async () => {
    stubAllReads([])

    renderPage(<VendorRegistryPage />)

    expect(await screen.findByText('Acme Devices')).toBeTruthy()
    expect(screen.getByText('Print Co')).toBeTruthy()
    expect(screen.getByText('Speedy Couriers')).toBeTruthy()
    expect(screen.getByText('MANUFACTURER')).toBeTruthy()
    expect(screen.getByText('PRINT')).toBeTruthy()
    expect(screen.getByText('COURIER')).toBeTruthy()
    expect(screen.getByText('SPD')).toBeTruthy()
    // Two of the three rows have a null courierCode: rendered as a dash, never
    // the literal string "null".
    expect(screen.queryByText('null')).toBeNull()
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(2)
  })

  it('CourierMasterPage shows ONLY type===COURIER rows and hides MANUFACTURER/PRINT', async () => {
    stubAllReads([])

    renderPage(<CourierMasterPage />)

    expect(await screen.findByText('Speedy Couriers')).toBeTruthy()
    expect(screen.getByText('SPD')).toBeTruthy()
    expect(screen.queryByText('Acme Devices')).toBeNull()
    expect(screen.queryByText('Print Co')).toBeNull()
    expect(screen.queryByText('MANUFACTURER')).toBeNull()
    expect(screen.queryByText('PRINT')).toBeNull()
  })

  it('Bank Masters tab renders rows from the real GET /ops/bank-masters read', async () => {
    const calls: Call[] = []
    stubAllReads(calls)

    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))

    expect(await screen.findByText('First National Bank')).toBeTruthy()
    expect(screen.getByText('FNB')).toBeTruthy()
    expect(screen.getByText('Mumbai')).toBeTruthy()
    expect(screen.getByText('IN')).toBeTruthy()
    expect(screen.getByText('9900011122')).toBeTruthy()
    expect(screen.getByText('ops@fnb.example')).toBeTruthy()
    expect(calls.some((c) => c.url.includes('/ops/bank-masters'))).toBe(true)
  })

  it('Damage Reasons tab renders rows and distinguishes active/inactive without a fabricated status', async () => {
    const calls: Call[] = []
    stubAllReads(calls)

    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Damage Reasons' }))

    expect(await screen.findByText('Water damage')).toBeTruthy()
    expect(screen.getByText('WATER')).toBeTruthy()
    expect(screen.getByText('Cracked screen')).toBeTruthy()
    expect(screen.getByText('CRACK')).toBeTruthy()
    // active:true -> 'Active' (the ratified StatusPill vocabulary), active:false
    // -> the neutral title-cased fallback 'Inactive'; never the raw booleans.
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Inactive')).toBeTruthy()
    expect(screen.queryByText('true')).toBeNull()
    expect(screen.queryByText('false')).toBeNull()
    expect(calls.some((c) => c.url.includes('/ops/damage-reasons'))).toBe(true)
  })

  it('Batching Config tab renders rows including a GLOBAL scope with null tenant/program', async () => {
    const calls: Call[] = []
    stubAllReads(calls)

    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Batching Config' }))

    expect(await screen.findByText('GLOBAL')).toBeTruthy()
    expect(screen.getByText('TENANT')).toBeTruthy()
    expect(screen.getByText('50')).toBeTruthy()
    expect(screen.getByText('3,600')).toBeTruthy()
    // The GLOBAL row's null tenantWire/programWire render as a dash, never
    // the literal string "null".
    expect(screen.queryByText('null')).toBeNull()
    expect(calls.some((c) => c.url.includes('/ops/batching-config'))).toBe(true)
  })

  // A FAILED READ MUST NOT BE REPORTED AS A COUNT, OR AS A RAW TypeError.
  //
  // Every view here holds `rows` as `T[] | null`, where null means "still
  // loading", and prints `${rows.length} <noun>` once it is not null. None of
  // them checked that the body was a list, because the type says it is. When a
  // read fails with a 200-shaped error envelope the count renders as the string
  // "undefined", so the card states something false.
  //
  // DataTable now refuses to render a non-array as an empty list, so the table
  // itself is honest, and the page no longer dies. These pin the other half:
  // the card must not report a count it does not have, and the operator must be
  // told the read failed.
  //
  // Found in a real browser, not here: with the table fixed the page rendered,
  // and the header read "undefined vendors".

  function stubBadBodyFor(fragment: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes(fragment)) return jsonResponse({ statusCode: 500, message: 'Internal Server Error' })
        return jsonResponse([])
      }),
    )
  }

  it('VendorRegistryPage states the read failed instead of printing "undefined vendors"', async () => {
    stubBadBodyFor('/ops/vendors')

    renderPage(<VendorRegistryPage />)

    expect(await screen.findByText('Unexpected response shape.')).toBeTruthy()
    // The count is the falsehood being guarded. Nothing on the card may say it.
    expect(screen.queryByText(/undefined/i)).toBeNull()
    // And the table says it could not show the rows, never "No vendors."
    expect(screen.getByText('Could not display these rows.')).toBeTruthy()
    expect(screen.queryByText('No vendors.')).toBeNull()
  })

  it('CourierMasterPage reports a failed read in operator language, not a raw TypeError', async () => {
    // This page filters the body before storing it, so a non-array throws
    // `res.filter is not a function` into the catch and shows THAT to an
    // operator. Surviving is not the same as being intelligible.
    stubBadBodyFor('/ops/vendors')

    renderPage(<CourierMasterPage />)

    expect(await screen.findByText('Unexpected response shape.')).toBeTruthy()
    expect(screen.queryByText(/is not a function/i)).toBeNull()
    expect(screen.queryByText(/undefined/i)).toBeNull()
  })

  it('Bank Masters tab states the read failed instead of printing "undefined banks"', async () => {
    stubBadBodyFor('/ops/bank-masters')

    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))

    expect(await screen.findByText('Unexpected response shape.')).toBeTruthy()
    expect(screen.queryByText(/undefined/i)).toBeNull()
    expect(screen.getByText('Could not display these rows.')).toBeTruthy()
  })

  it('has NO write controls anywhere and issues only GET reads across every tab', async () => {
    const calls: Call[] = []
    stubAllReads(calls)

    renderPage(<MasterDataPage />)

    const tabLabels = ['Vendor Registry', 'Courier Master', 'Bank Masters', 'Damage Reasons', 'Batching Config']
    for (const label of tabLabels) {
      await userEvent.click(screen.getByRole('button', { name: label }))
      // Wait for that tab's data (or its error/empty state) to settle before
      // inspecting the button set, since a race would just find the previous
      // tab's buttons (also none), silently passing for the wrong reason.
      await screen.findAllByRole('button')
      const buttons = screen.getAllByRole('button')
      const buttonNames = buttons.map((b) => b.textContent ?? '')
      // Every visible button must be a tab switch, never a write control.
      for (const name of buttonNames) {
        expect(tabLabels).toContain(name)
        expect(name).not.toMatch(WRITE_CONTROL_PATTERN)
      }
    }

    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      const method = (call.init.method ?? 'GET').toUpperCase()
      expect(method).toBe('GET')
    }
  })
})
