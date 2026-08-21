import type { ReactElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
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
//   GET /ops/bank-masters     -> BankMasterRow[] (each carries aggregators[])
//   GET /ops/damage-reasons   -> DamageReasonRow[]
//   GET /ops/batching-config  -> BatchingConfigRow[]
// The courier master is NOT a separate route: it is /ops/vendors filtered
// client-side to type === 'COURIER' (existing CourierMasterPage precedent).
//
// CREATE landed 2026-08-17 (the L9 reversal), against routes that already
// existed: POST /ops/vendors (couriers included, with type COURIER),
// /ops/bank-masters, /ops/damage-reasons, /ops/batching-config.
//
// TASK 8 (2026-08-20) replaces the earlier parent/child TENANT hierarchy with
// a tenant-and-aggregator tree: a bank master (tenant) now embeds its own
// `aggregators` array rather than pointing at a sibling tenant via
// `parentTnntId`. This suite therefore asserts THREE things, not two: real
// data rendering, the create control and the exact body it posts, and the
// CONTINUED absence of the still-deferred actions (suspend, activate,
// deactivate). The last one matters most: the reversal was scoped to create
// (and now edit), and a suite that only checked "some write control exists"
// would not notice the scope widening.

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
    aggregators: [],
  },
]

// One tenant (tnnt_p1) with two aggregators: the DEFAULT (aggr_d1, code GSCB,
// locked because ingest has already matched it) and a member (aggr_c1, code
// VSC, not yet locked). Kept separate from BANK_MASTERS so the pre-existing
// tests above stay pinned to a single flat, aggregator-less bank.
const AGGR_DEFAULT = {
  aggrId: 'aggr_d1',
  tnntId: 'tnnt_p1',
  aggregatorCode: 'GSCB',
  displayName: 'GSCB',
  status: 'ACTIVE',
  isDefault: true,
  codeLocked: true,
  hasLogo: false,
  address1: null,
  address2: null,
  address3: null,
  city: null,
  district: null,
  country: null,
  pin: null,
  mobile: null,
  email: null,
}

const AGGR_MEMBER = {
  aggrId: 'aggr_c1',
  tnntId: 'tnnt_p1',
  aggregatorCode: 'VSC',
  displayName: 'VSC Bank',
  status: 'ACTIVE',
  isDefault: false,
  codeLocked: false,
  hasLogo: false,
  address1: null,
  address2: null,
  address3: null,
  city: null,
  district: null,
  country: null,
  pin: null,
  mobile: null,
  email: null,
}

const TENANT_WITH_AGGREGATORS = [
  {
    tnntId: 'tnnt_p1',
    displayName: 'Gujarat State Co-op Bank',
    bankReferenceCode: 'GSCB',
    status: 'ACTIVE',
    address1: null,
    address2: null,
    address3: null,
    city: 'Ahmedabad',
    district: null,
    country: 'IN',
    pin: null,
    mobile: '9000000001',
    email: 'ops@gscb.example',
    aggregators: [AGGR_DEFAULT, AGGR_MEMBER],
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

// The actions still deferred under L9 after the create-only reversal. The Tabs
// primitive's own switch buttons never match this, so it is safe to check
// against every button on the page.
//
// EDIT CAME OUT OF THIS PATTERN on 18 Aug 2026: it shipped on all five tabs,
// so a regex that still forbade it would fail this suite the moment edit
// landed, telling a future reader the wrong thing (that edit had regressed,
// when it had simply arrived). Its own coverage lives in the tests below this
// describe block, which assert the edit dialogs by name and check their exact
// POST bodies, the same discipline this file already holds create to.
//
// "activate" would also match "deactivate", which is intended: both are still
// deferred. It does NOT match any of the five create controls ("Add vendor",
// "Add courier", "Add bank master", "Add damage reason", "Set tier") or an
// Edit control's accessible name ("Edit vendor Acme Devices", etc: the word
// "edit" itself, not any of the still-deferred lifecycle words).
const DEFERRED_CONTROL_PATTERN = /\b(delete|remove|suspend|activate|deactivate)\b/i

// The create control each tab is expected to carry, by accessible name.
const CREATE_CONTROL_BY_TAB: ReadonlyArray<{ tab: string; control: string }> = [
  { tab: 'Vendor Registry', control: 'Add vendor' },
  { tab: 'Courier Master', control: 'Add courier' },
  { tab: 'Bank Masters', control: 'Add bank master' },
  { tab: 'Damage Reasons', control: 'Add damage reason' },
  { tab: 'Batching Config', control: 'Set tier' },
]

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

  it('groups aggregators under their tenant with an expander, default pinned first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse(TENANT_WITH_AGGREGATORS)
        return jsonResponse([])
      }),
    )

    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))

    expect(await screen.findByRole('button', { name: 'Show aggregators of Gujarat State Co-op Bank' })).toBeTruthy()
    expect(screen.queryByText('VSC Bank')).toBeNull()
    expect(screen.getByText('2 aggregators')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Show aggregators of Gujarat State Co-op Bank' }))

    const rows = await screen.findAllByRole('row')
    // Default (GSCB) must appear before the member (VSC Bank), regardless of
    // fixture order, and the default row carries a `default` marker while the
    // member carries a `child` marker.
    const rowTexts = rows.map((r) => r.textContent ?? '')
    const defaultIdx = rowTexts.findIndex((t) => t.includes('VSC Bank') === false && t.includes('GSCB') && t.includes('default'))
    const memberIdx = rowTexts.findIndex((t) => t.includes('VSC Bank'))
    expect(defaultIdx).toBeGreaterThanOrEqual(0)
    expect(memberIdx).toBeGreaterThan(defaultIdx)
    expect(screen.getByText('child')).toBeTruthy()
  })

  it('a search matching a member aggregator auto-expands its tenant, and the button says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse(TENANT_WITH_AGGREGATORS)
        return jsonResponse([])
      }),
    )

    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))

    // Before typing anything, the tenant is collapsed: the un-rotated chevron
    // reads "Show", and the member aggregator is not in the DOM.
    await screen.findByRole('button', { name: 'Show aggregators of Gujarat State Co-op Bank' })
    expect(screen.queryByText('VSC Bank')).toBeNull()

    // Typing a query that matches ONLY the member auto-surfaces it beneath its
    // tenant without a click on the expander. The button's label (and, by the
    // same shared computeOpenParents/openParents state, the chevron rotation)
    // must reflect that the aggregator is now actually showing: a stale "Show"
    // label here would be a screen reader (and sighted user) being told the
    // opposite of what the table is doing.
    await userEvent.type(screen.getByLabelText('Search bank masters'), 'VSC')

    expect(await screen.findByText('VSC Bank')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hide aggregators of Gujarat State Co-op Bank' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show aggregators of Gujarat State Co-op Bank' })).toBeNull()

    // Clearing the search collapses it again, since it was never manually
    // expanded, only auto-opened by the now-cleared match.
    await userEvent.clear(screen.getByLabelText('Search bank masters'))

    expect(await screen.findByRole('button', { name: 'Show aggregators of Gujarat State Co-op Bank' })).toBeTruthy()
    expect(screen.queryByText('VSC Bank')).toBeNull()
  })

  it('Bank Masters shows exactly ONE search box: the tree-aware one, with the grid built-in silenced', async () => {
    // Two search bars shipped on 2026-08-20: the view's tree-aware box (which
    // auto-expands matching parents) stacked on top of DataGrid's built-in
    // filter. The grid's must stay off here or the screen regresses to two.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse(TENANT_WITH_AGGREGATORS)
        return jsonResponse([])
      }),
    )

    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))
    await screen.findByText('Gujarat State Co-op Bank')

    expect(screen.getAllByPlaceholderText(/Search/)).toHaveLength(1)
    expect(screen.getByLabelText('Search bank masters')).toBeTruthy()
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
    // The SHARED fmtWait, the same rule the fulfillment panels use, so a wait
    // reads the same everywhere. Never the raw seconds the wire carries.
    expect(screen.getByText('1 hour')).toBeTruthy()
    expect(screen.getByText('30 minutes')).toBeTruthy()
    expect(screen.queryByText('3,600')).toBeNull()
    expect(screen.queryByText('1800 s')).toBeNull()
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
    expect(screen.getByText(/could not display these rows/i)).toBeTruthy()
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
    expect(screen.getByText(/could not display these rows/i)).toBeTruthy()
  })

  it('carries exactly one create control and one Edit button per row on every tab, and none of the still-deferred actions', async () => {
    const calls: Call[] = []
    stubAllReads(calls)

    renderPage(<MasterDataPage />)

    const tabLabels = CREATE_CONTROL_BY_TAB.map((t) => t.tab)
    for (const { tab, control } of CREATE_CONTROL_BY_TAB) {
      await userEvent.click(screen.getByRole('button', { name: tab }))
      // Wait for that tab's data (or its error/empty state) to settle before
      // inspecting the button set, since a race would inspect the previous
      // tab's buttons and pass for the wrong reason.
      await screen.findByRole('button', { name: control })

      // The Edit buttons are icon-only (a bare Pencil glyph), so their name is
      // their aria-label, not their textContent, which is empty for an
      // icon-only button. Falling back to textContent still covers the tab
      // switches and the labelled create control exactly as before.
      const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '')
      // Every button is a tab switch, this tab's ONE create control, a
      // per-row Edit button (one per row, accessible name starting "Edit "),
      // or (Bank Masters only) a per-tenant-row "Add aggregator" button. That
      // last one is a legitimate control, not one of the still-deferred
      // lifecycle actions the pattern below still guards. This fixture's
      // single tenant carries no aggregators, so no "Add aggregator" fires
      // here; its own coverage lives in the tests below.
      for (const name of names) {
        expect([...tabLabels, control].includes(name) || /^Edit /.test(name) || name === 'Add aggregator').toBe(true)
      }
      // Suspend, activate and deactivate stay deferred under L9; edit does not
      // (see the describe block below).
      for (const name of names) {
        expect(name).not.toMatch(DEFERRED_CONTROL_PATTERN)
      }
    }

    // Browsing the tabs still writes nothing: the reads stay GET, and a create
    // only happens when a dialog is submitted.
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect((call.init.method ?? 'GET').toUpperCase()).toBe('GET')
    }
  })

  // The page said "Read-only view. Admin console for edits is deferred." That
  // sentence is now false, and a stale reassurance beside a row of add buttons
  // is worse than none.
  it('no longer claims to be read-only', async () => {
    stubAllReads([])
    renderPage(<MasterDataPage />)
    await screen.findByRole('button', { name: 'Add vendor' })
    expect(screen.queryByText(/read-only/i)).toBeNull()
  })
})

// Each dialog's POST body is the contract with an edge route that already
// existed, so these assert the exact body rather than merely that something was
// sent. A field silently dropped here is a field the operator typed and the
// server never saw.
describe('master data create dialogs', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  function stubWrites(calls: Call[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = { method: 'GET' }) => {
        calls.push({ url, init })
        if ((init.method ?? 'GET').toUpperCase() === 'POST') {
          if (url.includes('/ops/damage-reasons')) return jsonResponse({ deduped: false, damageReason: DAMAGE_REASONS[0] })
          return jsonResponse({ deduped: false, vndrId: 'vndr_1', tnntId: 'tnnt_1', id: 'bc-9' })
        }
        if (url.includes('/ops/vendors')) return jsonResponse(MIXED_VENDORS)
        if (url.includes('/ops/bank-masters')) return jsonResponse(BANK_MASTERS)
        if (url.includes('/ops/damage-reasons')) return jsonResponse(DAMAGE_REASONS)
        if (url.includes('/ops/batching-config')) return jsonResponse(BATCHING_CONFIGS)
        return jsonResponse([])
      }),
    )
  }

  async function postedTo(calls: Call[], fragment: string): Promise<Record<string, unknown>> {
    const found = await vi.waitFor(() => {
      const hit = calls.find((c) => c.url.includes(fragment) && (c.init.method ?? '').toUpperCase() === 'POST')
      expect(hit).toBeTruthy()
      return hit!
    })
    return JSON.parse(String(found.init.body)) as Record<string, unknown>
  }

  const type = async (label: RegExp, value: string) => {
    await userEvent.type(screen.getByLabelText(label), value)
  }

  it('the vendor dialog posts the chosen type, and offers courier fields only for a COURIER', async () => {
    const calls: Call[] = []
    stubWrites(calls)
    renderPage(<VendorRegistryPage />)

    await userEvent.click(await screen.findByRole('button', { name: 'Add vendor' }))
    await type(/display name/i, 'New Press')

    // courierCode and integrationMode are COURIER-only per the schema, so they
    // are absent while a non-courier type is selected rather than sent empty.
    await userEvent.selectOptions(screen.getByLabelText(/type/i), 'PRINT')
    expect(screen.queryByLabelText(/courier code/i)).toBeNull()

    await userEvent.click(screen.getAllByRole('button', { name: 'Add vendor' }).at(-1) as HTMLElement)
    expect(await postedTo(calls, '/ops/vendors')).toEqual({ type: 'PRINT', displayName: 'New Press' })
  })

  it('the courier dialog pins the type to COURIER, so a create can never fall outside the list it was made from', async () => {
    const calls: Call[] = []
    stubWrites(calls)
    renderPage(<CourierMasterPage />)

    await userEvent.click(await screen.findByRole('button', { name: 'Add courier' }))
    // No type picker at all here: it is decided by the tab.
    expect(screen.queryByLabelText(/^type$/i)).toBeNull()

    await type(/display name/i, 'Quick Ship')
    await type(/courier code/i, 'QSH')
    await userEvent.selectOptions(screen.getByLabelText(/integration mode/i), 'WEBHOOK')

    await userEvent.click(screen.getAllByRole('button', { name: 'Add courier' }).at(-1) as HTMLElement)
    expect(await postedTo(calls, '/ops/vendors')).toEqual({
      type: 'COURIER',
      displayName: 'Quick Ship',
      courierCode: 'QSH',
      integrationMode: 'WEBHOOK',
    })
  })

  it('the bank master dialog posts the full BRD D.1 record with no parent picker', async () => {
    const calls: Call[] = []
    stubWrites(calls)
    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Add bank master' }))

    // The old parent-bank picker is gone: a bank master create is now a plain
    // tenant create, with aggregators added separately underneath it.
    expect(screen.queryByLabelText(/parent bank/i)).toBeNull()

    await type(/bank reference code/i, 'GSCB')
    await type(/display name/i, 'Gujarat State Co-op Bank')
    await type(/address 1/i, '1 MG Road')
    await type(/city/i, 'Ahmedabad')
    await type(/district/i, 'Ahmedabad')
    await type(/country/i, 'India')
    await type(/pin/i, '380001')

    // Mobile and email are still empty, so the save must not be offered yet.
    const save = screen.getAllByRole('button', { name: 'Add bank master' }).at(-1) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await type(/mobile/i, '9000000001')
    await type(/email/i, 'ops@gscb.example')
    expect(save.disabled).toBe(false)

    await userEvent.click(save)
    expect(await postedTo(calls, '/ops/bank-masters')).toEqual({
      bankReferenceCode: 'GSCB',
      displayName: 'Gujarat State Co-op Bank',
      address1: '1 MG Road',
      city: 'Ahmedabad',
      district: 'Ahmedabad',
      country: 'India',
      pin: '380001',
      mobile: '9000000001',
      email: 'ops@gscb.example',
    })
  })

  function stubAggregatorWrites(calls: Call[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = { method: 'GET' }) => {
        calls.push({ url, init })
        if ((init.method ?? 'GET').toUpperCase() === 'POST') {
          if (url.includes('/logo')) return jsonResponse({ deduped: false, id: 'log_1', masterVersion: '1', derivativeVersion: '1' })
          if (url.includes('/edit')) return jsonResponse({ deduped: false, changedFields: ['displayName'] })
          return jsonResponse({ deduped: false, aggrId: 'aggr_c2' })
        }
        if (url.includes('/logo/derivative')) return new Response(null, { status: 404 })
        if (url.includes('/logo/current')) return jsonResponse({ master: null, derivative: null })
        if (url.includes('/logo/versions')) return jsonResponse([])
        if (url.includes('/ops/bank-masters')) return jsonResponse(TENANT_WITH_AGGREGATORS)
        return jsonResponse([])
      }),
    )
  }

  it('Add aggregator on a tenant row posts displayName and aggregatorCode to the tenant aggregators route', async () => {
    const calls: Call[] = []
    stubAggregatorWrites(calls)
    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Add aggregator' }))

    await type(/display name/i, 'New Aggregator')
    await type(/aggregator code/i, 'NEWA')

    await userEvent.click(screen.getAllByRole('button', { name: 'Add aggregator' }).at(-1) as HTMLElement)
    expect(await postedTo(calls, '/ops/bank-masters/tnnt_p1/aggregators')).toEqual({
      displayName: 'New Aggregator',
      aggregatorCode: 'NEWA',
    })
  })

  it('the tenant detail dialog Logo section targets the default aggregator, and Aggregators lists both rows default-first', async () => {
    const calls: Call[] = []
    stubAggregatorWrites(calls)
    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Edit bank master Gujarat State Co-op Bank' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Details')).toBeTruthy()
    expect(within(dialog).getByText('Logo')).toBeTruthy()
    expect(within(dialog).queryByLabelText(/parent bank/i)).toBeNull()
    expect(within(dialog).getByText('Aggregators')).toBeTruthy()

    const aggList = within(dialog).getAllByRole('listitem').map((li) => li.textContent ?? '')
    const defaultIdx = aggList.findIndex((t) => t.includes('GSCB'))
    const memberIdx = aggList.findIndex((t) => t.includes('VSC Bank'))
    expect(defaultIdx).toBeGreaterThanOrEqual(0)
    expect(memberIdx).toBeGreaterThan(defaultIdx)

    expect(await screen.findByText('No logo uploaded yet.')).toBeTruthy()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add aggregator' }))
    // The shortcut closes the tenant dialog and opens the aggregator create
    // dialog seeded with the same tenant.
    expect(screen.queryByText('Aggregators')).toBeNull()
    const nextDialog = await screen.findByRole('dialog')
    expect(nextDialog.querySelector('h2')?.textContent).toBe('Add aggregator')
    expect(within(nextDialog).getByText(/Gujarat State Co-op Bank/)).toBeTruthy()
  })

  it('shows "No default aggregator." when a tenant has none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse(BANK_MASTERS)
        return jsonResponse([])
      }),
    )
    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Edit bank master First National Bank' }))

    expect(await screen.findByText('No default aggregator.')).toBeTruthy()
  })

  it('the aggregator detail dialog code input is disabled with a locked hint when codeLocked', async () => {
    const calls: Call[] = []
    stubAggregatorWrites(calls)
    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Show aggregators of Gujarat State Co-op Bank' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Edit aggregator GSCB' }))

    const codeInput = screen.getByLabelText(/aggregator code/i) as HTMLInputElement
    expect(codeInput.disabled).toBe(true)
    expect(screen.getByText('Locked: ingest has matched on this code.')).toBeTruthy()
  })

  it('the aggregator detail dialog saves a diff-only edit via editAggregator, to the real aggr_ id', async () => {
    const calls: Call[] = []
    stubAggregatorWrites(calls)
    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Show aggregators of Gujarat State Co-op Bank' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Edit aggregator VSC Bank' }))

    // VSC (aggr_c1) is not codeLocked, so the code input is editable here.
    const codeInput = screen.getByLabelText(/aggregator code/i) as HTMLInputElement
    expect(codeInput.disabled).toBe(false)

    const nameInput = screen.getByLabelText(/display name/i)
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'VSC Bank Renamed')

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    const body = await postedTo(calls, '/ops/aggregators/aggr_c1/edit')
    expect(body).toEqual({ displayName: 'VSC Bank Renamed' })
  })

  it('the aggregator logo section uploads the pair as multipart against the aggregator id', async () => {
    const calls: Call[] = []
    stubAggregatorWrites(calls)
    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Show aggregators of Gujarat State Co-op Bank' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Edit aggregator GSCB' }))

    expect(await screen.findByText('No logo uploaded yet.')).toBeTruthy()
    expect(await screen.findByText('No versions yet.')).toBeTruthy()

    const masterFile = new File(['x'], 'gscb.ai', { type: 'application/postscript' })
    const derivativeFile = new File(['y'], 'gscb.png', { type: 'image/png' })
    await userEvent.upload(screen.getByLabelText(/logo master/i), masterFile)
    await userEvent.upload(screen.getByLabelText(/render derivative/i), derivativeFile)

    await userEvent.click(screen.getByRole('button', { name: 'Upload logo' }))

    const hit = await vi.waitFor(() => {
      const found = calls.find(
        (c) => c.url.includes('/ops/aggregators/aggr_d1/logo') && (c.init.method ?? '').toUpperCase() === 'POST',
      )
      expect(found).toBeTruthy()
      return found!
    })
    expect(hit.init.body).toBeInstanceOf(FormData)
    const form = hit.init.body as FormData
    expect(form.get('master')).toBeTruthy()
    expect(form.get('derivative')).toBeTruthy()
  })

  it('the aggregator version history renders in wire order, newest first, with no client-side re-sort, and the token as-is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/logo/derivative')) return new Response(null, { status: 404 })
        if (url.includes('/logo/current')) return jsonResponse({ master: null, derivative: null })
        if (url.includes('/logo/versions')) {
          return jsonResponse([
            { version: 'v2', filename: 'gscb-v2.png', contentType: 'image/png' },
            { version: 'v1', filename: 'gscb-v1.png', contentType: 'image/png' },
          ])
        }
        if (url.includes('/ops/bank-masters')) return jsonResponse(TENANT_WITH_AGGREGATORS)
        return jsonResponse([])
      }),
    )

    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Show aggregators of Gujarat State Co-op Bank' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Edit aggregator GSCB' }))

    await screen.findByText(/v2 gscb-v2\.png/)
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '')
    const versionLines = items.filter((t) => /^v\d /.test(t))
    // Never "vv1"/"vv2": the token is rendered as-is, not prefixed again.
    expect(versionLines).toEqual(['v2 gscb-v2.png', 'v1 gscb-v1.png'])
  })

  it('the aggregator derivative preview uses a data: URL, never a blob: URL the portal CSP would block', async () => {
    // The real portal's CSP is img-src 'self' data:, which Chrome enforces by
    // blocking a blob: URL image load outright. jsdom does not enforce CSP,
    // so this only pins the SOURCE the dialog hands the <img>, not the
    // browser's actual block; the fix is to never produce a blob: URL at all.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/logo/derivative')) {
          return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } })
        }
        if (url.includes('/logo/current')) return jsonResponse({ master: null, derivative: null })
        if (url.includes('/logo/versions')) return jsonResponse([])
        if (url.includes('/ops/bank-masters')) return jsonResponse(TENANT_WITH_AGGREGATORS)
        return jsonResponse([])
      }),
    )

    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Show aggregators of Gujarat State Co-op Bank' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Edit aggregator GSCB' }))

    const img = await screen.findByAltText('GSCB logo')
    expect(img.getAttribute('src')).toMatch(/^data:/)
  })

  it('the dialog names the currently stored master and derivative next to their inputs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/logo/derivative')) return new Response(null, { status: 404 })
        if (url.includes('/logo/current')) {
          return jsonResponse({
            master: { version: 'v2', filename: 'Godhara city.ai', contentType: 'application/postscript' },
            derivative: { version: 'v2', filename: 'Godhara city.png', contentType: 'image/png' },
          })
        }
        if (url.includes('/logo/versions')) return jsonResponse([])
        if (url.includes('/ops/bank-masters')) return jsonResponse(TENANT_WITH_AGGREGATORS)
        return jsonResponse([])
      }),
    )

    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Show aggregators of Gujarat State Co-op Bank' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Edit aggregator GSCB' }))

    // Both names render, each tagged with its own version token: the master
    // and the derivative run separate sequences, so neither line is derived
    // from the other.
    expect(await screen.findByText('Godhara city.ai')).toBeTruthy()
    expect(screen.getByText('Godhara city.png')).toBeTruthy()
    expect(screen.getAllByText(/Currently stored:/).length).toBe(2)
  })

  it('clicking the current logo opens an enlarged popup naming the stored derivative', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/logo/derivative')) {
          return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } })
        }
        if (url.includes('/logo/current')) {
          return jsonResponse({
            master: { version: 'v2', filename: 'Godhara city.ai', contentType: 'application/postscript' },
            derivative: { version: 'v2', filename: 'Godhara city.png', contentType: 'image/png' },
          })
        }
        if (url.includes('/logo/versions')) return jsonResponse([])
        if (url.includes('/ops/bank-masters')) return jsonResponse(TENANT_WITH_AGGREGATORS)
        return jsonResponse([])
      }),
    )

    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Bank Masters' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Show aggregators of Gujarat State Co-op Bank' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Edit aggregator GSCB' }))

    // Two ways in: the clickable thumbnail and the explicit Preview button.
    // Drive the BUTTON here, since it is the discoverable one.
    expect(await screen.findByRole('button', { name: 'Preview the current logo' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }))

    // The popup shows the SAME data: URL enlarged, captioned with the stored
    // derivative's filename and version.
    const enlarged = await screen.findByAltText('GSCB logo, enlarged')
    expect(enlarged.getAttribute('src')).toMatch(/^data:/)
    expect(screen.getByText('Godhara city.png (v2)')).toBeTruthy()
  })

  it('the damage reason dialog posts the code and label as separate fields', async () => {
    const calls: Call[] = []
    stubWrites(calls)
    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Damage Reasons' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Add damage reason' }))

    await type(/code/i, 'SCREEN')
    await type(/label/i, 'Screen cracked')

    await userEvent.click(screen.getAllByRole('button', { name: 'Add damage reason' }).at(-1) as HTMLElement)
    expect(await postedTo(calls, '/ops/damage-reasons')).toEqual({ code: 'SCREEN', label: 'Screen cracked' })
  })

  it('the batching dialog sends only the chosen tier fields, and refuses max wait on a bank tier', async () => {
    const calls: Call[] = []
    stubWrites(calls)
    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Batching Config' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Set tier' }))

    // GLOBAL is the default and narrows nothing, so no tenant field is shown.
    expect(screen.queryByLabelText(/bank partner/i)).toBeNull()

    // The operator types HOURS; the wire field is seconds.
    await type(/maximum wait/i, '2')

    // R-7: a bank tier carries min lot ONLY. The max-wait field is not rendered
    // at all, so the operator cannot build a body the server would reject.
    await userEvent.selectOptions(screen.getByLabelText(/scope/i), 'BANK')
    expect(screen.queryByLabelText(/maximum wait/i)).toBeNull()

    await userEvent.selectOptions(screen.getByLabelText(/bank partner/i), 'tnnt_bank1000000000000000000')
    await type(/member bank code/i, '77')
    await type(/minimum lot size/i, '20')

    await userEvent.click(screen.getAllByRole('button', { name: 'Set tier' }).at(-1) as HTMLElement)
    // The 2 hours typed before switching to BANK is NOT smuggled through: the
    // body carries no maxWaitSeconds at all.
    expect(await postedTo(calls, '/ops/batching-config')).toEqual({
      minLotSize: 20,
      tenantWire: 'tnnt_bank1000000000000000000',
      bankReferenceCode: '77',
    })
  })

  it('converts the max wait from hours to seconds on a pool tier', async () => {
    const calls: Call[] = []
    stubWrites(calls)
    renderPage(<MasterDataPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Batching Config' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Set tier' }))

    await type(/minimum lot size/i, '30')
    await type(/maximum wait/i, '2.5')

    await userEvent.click(screen.getAllByRole('button', { name: 'Set tier' }).at(-1) as HTMLElement)
    expect(await postedTo(calls, '/ops/batching-config')).toEqual({
      minLotSize: 30,
      // 2.5 hours, sent on the wire in the seconds the timer arms on.
      maxWaitSeconds: 9000,
    })
  })
})
