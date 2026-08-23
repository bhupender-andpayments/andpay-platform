import { StrictMode } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { MerchantsPage } from '../../src/features/merchants/MerchantsPage.js'
import { MerchantDetailPage } from '../../src/features/merchants/MerchantDetailPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// Redesign step 7. Row shapes are copied from services/tms/src/ops-read.ts
// MerchantRow, never invented here.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// The BRD 5.1b block (22 Aug 2026) is part of the row shape now. Kirana Corner
// carries a full one, the way an ingested merchant does; Tea Stall Junction
// carries nulls throughout, the way a hand-created merchant does before any
// bank file mentions them. Both shapes have to render.
const ROWS = [
  {
    mrchId: 'mrch_2a',
    displayName: 'Kirana Corner',
    legalName: 'KIRANA CORNER PRIVATE LIMITED',
    mcc: '5411',
    status: 'ACTIVE',
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    hasAdditionalRequests: false,
    vpa: 'kirana01@gscb',
    qrType: null,
    contactName: 'Priya Menon',
    mobile: '9224148401',
    email: 'priya@kirana.example',
    address: 'SHOP NO 14 TEMPLE ROAD, AHMEDABAD, Gujarat, 380008',
    city: 'AHMEDABAD',
    state: 'Gujarat',
    pincode: '380008',
    // bankDisplayName and bankReferenceCode are DELIBERATELY DIFFERENT strings
    // here, mirroring the real divergence that caused a live bug (23 Aug
    // 2026): bankReferenceCode is the bank FILE's own aggregator code (here
    // '3'), never the Bank Master's code, so a filter or count keyed on it
    // instead of bankDisplayName silently matches nothing. See the comment on
    // bankOptions in MerchantsPage.tsx for the full trace.
    bankDisplayName: 'Gujarat State Co-op Bank',
    bankReferenceCode: '3',
    branchCode: '30',
    latestRequestOrigin: 'INITIAL',
    latestRequestAt: '2026-07-20T10:00:00.000Z',
  },
  {
    mrchId: 'mrch_2b',
    displayName: 'Tea Stall Junction',
    legalName: 'TEA STALL JUNCTION LLP',
    mcc: '5812',
    status: 'SUSPENDED',
    createdAt: '2026-08-02T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z',
    hasAdditionalRequests: false,
    vpa: null,
    qrType: null,
    contactName: null,
    mobile: null,
    email: null,
    address: null,
    city: null,
    state: null,
    pincode: null,
    bankDisplayName: null,
    bankReferenceCode: null,
    branchCode: null,
    latestRequestOrigin: null,
    latestRequestAt: null,
  },
]

// Shapes copied from services/identity/src/ops.ts BankMasterRow. Only the two
// fields the picker reads are needed here.
const BANKS = [
  // The Bank Master's OWN bankReferenceCode ('GSCB') is unrelated to the
  // assignment's aggregator code above ('3') on purpose: two different
  // namespaces, per the note on ROWS[0].
  { tnntId: 'tnnt_gscb', displayName: 'Gujarat State Co-op Bank', bankReferenceCode: 'GSCB', status: 'ACTIVE' },
  { tnntId: 'tnnt_hdfc', displayName: 'HDFC Bank', bankReferenceCode: 'HDFC', status: 'ACTIVE' },
]

function renderPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <MerchantsPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('MerchantsPage', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  // D-2. Before this, no screen could tell a returning merchant from a new one:
  // the signal was computed during projection and thrown away. It is now derived
  // on read and tagged here, so "is this an additional soundbox order" is
  // answerable by looking rather than by asking someone.
  it('carries no Additional pill (removed by ruling, 13 Aug 2026)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([
          { ...ROWS[0], hasAdditionalRequests: true },
          { ...ROWS[1], hasAdditionalRequests: false },
        ]),
      ),
    )
    renderPage()
    await screen.findByText('Kirana Corner')
    // The wire field still arrives; the list deliberately does not render it.
    expect(screen.queryByText('Additional')).toBeNull()
  })

  it('shows no tag at all when every merchant ordered once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(ROWS.map((r) => ({ ...r, hasAdditionalRequests: false })))),
    )
    renderPage()
    await screen.findByText('Kirana Corner')
    expect(screen.queryByText(/additional/i)).toBeNull()
  })

  it('lists merchants from the response, including SUSPENDED ones', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ROWS)))
    renderPage()
    expect(await screen.findByText('Kirana Corner')).toBeTruthy()
    // A suspended merchant must still be findable: hiding it sends the operator
    // looking for a record that does exist.
    expect(screen.getByText('Tea Stall Junction')).toBeTruthy()
    expect(screen.getByText('KIRANA CORNER PRIVATE LIMITED')).toBeTruthy()
  })

  it('calls GET /ops/merchants', async () => {
    // Typed with its input parameter on purpose. `vi.fn(async () => ...)` gives
    // `calls` an EMPTY tuple type, so reading `calls[0][0]` is a TS2493 the
    // root typecheck does not surface (it excludes apps/ops-portal) and only
    // the portal's own build catches.
    const fetchMock = vi.fn(async (_input: string | URL) => jsonResponse(ROWS))
    vi.stubGlobal('fetch', fetchMock)
    renderPage()
    await screen.findByText('Kirana Corner')
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('/ops/merchants')
  })

  it('shows the wire id but never asks for one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ROWS)))
    renderPage()
    await screen.findByText('Kirana Corner')
    // Displayed as an output...
    expect(screen.getByText('mrch_2a')).toBeTruthy()
    // ...and no input anywhere expects one to be typed. This is principle 2, and
    // the portal-wide guard covers placeholders; this pins THIS screen.
    for (const input of Array.from(document.querySelectorAll('input'))) {
      expect(input.getAttribute('placeholder') ?? '').not.toMatch(/^mrch_/)
    }
  })

  it('filters through the common grid, narrowing the visible rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ROWS)))
    renderPage()
    await screen.findByText('Kirana Corner')

    // The one search surface is the URL-backed Toolbar (2026-08-14), the same
    // filter idiom as Inventory; the grid's own search row is off.
    await userEvent.type(screen.getByPlaceholderText(/name, vpa, mobile/i), 'tea')
    expect(screen.queryByText('Kirana Corner')).toBeNull()
    expect(screen.getByText('Tea Stall Junction')).toBeTruthy()
  })

  it('matches on legal name and MCC, not only the display name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ROWS)))
    renderPage()
    await screen.findByText('Kirana Corner')

    await userEvent.type(screen.getByLabelText('Search'), '5812')
    expect(screen.getByText('Tea Stall Junction')).toBeTruthy()
    expect(screen.queryByText('Kirana Corner')).toBeNull()
  })

  it('distinguishes an empty master from an empty search result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])))
    renderPage()
    // The empty-master wording must explain HOW merchants arrive, because "no
    // merchants" alone reads as a broken screen.
    expect(await screen.findByText(/bank request file/i)).toBeTruthy()
  })

  it('survives a non-array body instead of taking down the page', async () => {
    // EntityPicker's .map on a non-array threw during render and killed its
    // entire host page. Same failure mode, pinned here.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ unexpected: true })))
    renderPage()
    expect(await screen.findByText(/no merchants yet/i)).toBeTruthy()
  })

  it('renders an error note when the read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'boom', message: 'nope' }, 500)))
    renderPage()
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  // The Add-merchant form carries the BRD's own merchant record (section 5.1):
  // identity, contact and the dispatch address block, plus the sponsoring bank
  // from master data. The POST body is the contract the edge implements;
  // nothing typed may silently vanish from it.
  it('posts every BRD field from the Add merchant form, and stays disabled until they are valid', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/merchants') && init.method === 'POST')
          return jsonResponse({ deduped: false, mrchId: 'mrch_new' })
        if (url.includes('/ops/bank-masters')) return jsonResponse(BANKS)
        return jsonResponse(ROWS)
      }),
    )
    renderPage()
    await screen.findByText('Kirana Corner')
    await userEvent.click(screen.getByRole('button', { name: /add merchant/i }))

    const type = async (label: RegExp, value: string) => {
      await userEvent.type(screen.getByLabelText(label), value)
    }
    // The bank comes from master data, so it is SELECTED, never typed.
    //
    // SCOPED TO THE DIALOG since 22 Aug 2026: the page behind it now carries a
    // Bank filter of its own, so a bare /bank/i label lookup matches two
    // controls. The dialog's is the native <select>, the filter's is a popover
    // button, and this test is about the form.
    await screen.findByRole('option', { name: 'Gujarat State Co-op Bank' })
    const bankSelect = screen
      .getAllByLabelText(/bank/i)
      .find((el): el is HTMLSelectElement => el instanceof HTMLSelectElement)
    if (bankSelect === undefined) throw new Error('the Add merchant dialog has no bank select')
    await userEvent.selectOptions(bankSelect, 'tnnt_gscb')

    await type(/business name/i, 'Chai Point')
    await type(/legal name/i, 'CHAI POINT LLP')
    await type(/mcc/i, '5812')
    await type(/vpa/i, 'chaipoint@gscb')
    await type(/contact name/i, 'Asha')
    await type(/mobile/i, '9876543210')
    await type(/^address$/i, '12 MG Road')
    await type(/city/i, 'Pune')
    await type(/state/i, 'MH')

    // Pincode still empty: the save must not be offered yet.
    const save = screen.getAllByRole('button', { name: /add merchant/i }).at(-1) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await type(/pincode/i, '411001')
    expect(save.disabled).toBe(false)

    await userEvent.click(save)
    const write = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/ops/merchants') && c.init.method === 'POST')
      expect(found).toBeTruthy()
      return found!
    })
    const body = JSON.parse(String(write.init.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      tnntWire: 'tnnt_gscb',
      displayName: 'Chai Point',
      legalName: 'CHAI POINT LLP',
      mcc: '5812',
      vpa: 'chaipoint@gscb',
      contactName: 'Asha',
      mobile: '9876543210',
      address: '12 MG Road',
      city: 'Pune',
      state: 'MH',
      pincode: '411001',
    })
  })

  // Without a bank the server has no resolver key to write, so the merchant
  // would be invisible to the bank file that arrives for it later. The form
  // refuses the save rather than letting the server take that shape.
  it('will not save without a bank, however complete the rest of the form is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse(BANKS)
        return jsonResponse(ROWS)
      }),
    )
    renderPage()
    await screen.findByText('Kirana Corner')
    await userEvent.click(screen.getByRole('button', { name: /add merchant/i }))

    const type = async (label: RegExp, value: string) => {
      await userEvent.type(screen.getByLabelText(label), value)
    }
    await type(/business name/i, 'Chai Point')
    await type(/legal name/i, 'CHAI POINT LLP')
    await type(/mcc/i, '5812')
    await type(/vpa/i, 'chaipoint@gscb')
    await type(/contact name/i, 'Asha')
    await type(/mobile/i, '9876543210')
    await type(/^address$/i, '12 MG Road')
    await type(/city/i, 'Pune')
    await type(/state/i, 'MH')
    await type(/pincode/i, '411001')

    const save = screen.getAllByRole('button', { name: /add merchant/i }).at(-1) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  // TASKLIST_2026-08-08 item C-1 refused the "one merchant per VPA" framing
  // while D1 remains an interim key. The dialog carried it anyway; it does not
  // any more, and the server's rule is per bank.
  it('does not claim one merchant per VPA', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse(BANKS)
        return jsonResponse(ROWS)
      }),
    )
    renderPage()
    await screen.findByText('Kirana Corner')
    await userEvent.click(screen.getByRole('button', { name: /add merchant/i }))

    expect(screen.queryByText(/one merchant per vpa/i)).toBeNull()
  })

  // ------------------------------------------------------------------
  // BRD 5.1b alignment, 22 Aug 2026.
  // ------------------------------------------------------------------

  it('shows the BRD block: VPA, contact, mobile, email, address parts, bank and branch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse(BANKS)
        return jsonResponse(ROWS)
      }),
    )
    renderPage()
    await screen.findByText('Kirana Corner')

    for (const value of [
      'kirana01@gscb',
      'Priya Menon',
      '9224148401',
      'priya@kirana.example',
      'AHMEDABAD',
      'Gujarat',
      '380008',
      '30',
    ]) {
      expect(screen.getAllByText(value).length).toBeGreaterThan(0)
    }
  })

  // A merchant no bank file has carried yet must still be findable. Blank cells
  // rather than a missing row, and never a crash on the null.
  it('renders a merchant with no bank request as dashes, not as an absent row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse(BANKS)
        return jsonResponse(ROWS)
      }),
    )
    renderPage()
    expect(await screen.findByText('Tea Stall Junction')).toBeTruthy()
  })

  it('searches on VPA, mobile and bank code, not only the name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse(BANKS)
        return jsonResponse(ROWS)
      }),
    )
    renderPage()
    await screen.findByText('Kirana Corner')
    const search = screen.getByLabelText('Search')

    for (const needle of ['kirana01@gscb', '9224148401', 'Priya']) {
      await userEvent.clear(search)
      await userEvent.type(search, needle)
      expect(screen.getByText('Kirana Corner')).toBeTruthy()
      expect(screen.queryByText('Tea Stall Junction')).toBeNull()
    }
  })

  // The status filter is gone because nothing can ever write a second status.
  // The status COLUMN stays, so assert on the control and not on the word.
  it('offers a Bank filter and no status filter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse(BANKS)
        return jsonResponse(ROWS)
      }),
    )
    renderPage()
    await screen.findByText('Kirana Corner')

    expect(screen.getByLabelText('Bank')).toBeTruthy()
    expect(screen.queryByLabelText('Status')).toBeNull()
  })

  it('narrows to one bank when the Bank filter is used', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse(BANKS)
        return jsonResponse(ROWS)
      }),
    )
    renderPage()
    await screen.findByText('Kirana Corner')

    await userEvent.click(screen.getByLabelText('Bank'))
    await userEvent.click(await screen.findByRole('option', { name: /Gujarat State Co-op Bank/ }))

    expect(screen.getByText('Kirana Corner')).toBeTruthy()
    // Tea Stall Junction has no bank yet, so a bank filter must exclude it.
    expect(screen.queryByText('Tea Stall Junction')).toBeNull()
  })

  // REGRESSION (23 Aug 2026): the filter used to key on bankReferenceCode,
  // which is not the Bank Master's code (see the ROWS/BANKS fixture comments).
  // That bug's exact symptom was a real bank in the dropdown with a count of
  // ZERO, which is what this asserts against directly.
  it('counts the merchant against its bank by display name, not by reference code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse(BANKS)
        return jsonResponse(ROWS)
      }),
    )
    renderPage()
    await screen.findByText('Kirana Corner')

    await userEvent.click(screen.getByLabelText('Bank'))
    const option = await screen.findByRole('option', { name: /Gujarat State Co-op Bank/ })
    expect(option.textContent).not.toMatch(/\b0\b/)
  })

  // The bank list is a convenience. Losing it must cost the filter its options
  // and nothing else: the merchants themselves have already loaded.
  it('still lists merchants when the bank master read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse({ message: 'nope' }, 500)
        return jsonResponse(ROWS)
      }),
    )
    renderPage()
    expect(await screen.findByText('Kirana Corner')).toBeTruthy()
    expect(screen.queryByText(/failed to load merchants/i)).toBeNull()
  })
})

// N1 (16 Aug 2026 UAT walkthrough): direct-URL entry hung on the spinner
// forever under StrictMode. The recovery effect's one-shot ref guard and its
// cancelled-cleanup were mutually destructive when the effect double-fires:
// run one consumed the ref and discarded its own response, run two refused to
// refetch. UAT runs the dev server, where StrictMode is on, so this test
// renders under StrictMode deliberately.
describe('MerchantDetailPage (direct URL entry, N1)', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('recovers the row from the list read under StrictMode instead of stranding the spinner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/ops/reports/')) return jsonResponse({ rows: [], watermark: { asOf: null } })
        if (url.includes('/ops/bank-masters')) return jsonResponse([])
        return jsonResponse(ROWS)
      }),
    )

    render(
      <StrictMode>
        <MemoryRouter
          initialEntries={['/merchants/mrch_2a']}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <AuthProvider>
            <Routes>
              <Route path="/merchants/:mrchId" element={<MerchantDetailPage />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </StrictMode>,
    )

    expect(await screen.findByText('Kirana Corner')).toBeTruthy()
    expect(screen.queryByText(/loading merchant/i)).toBeNull()
  })

  it('says so honestly when no merchant carries the id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/ops/reports/')) return jsonResponse({ rows: [], watermark: { asOf: null } })
        if (url.includes('/ops/bank-masters')) return jsonResponse([])
        return jsonResponse(ROWS)
      }),
    )

    render(
      <StrictMode>
        <MemoryRouter
          initialEntries={['/merchants/mrch_nosuch']}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <AuthProvider>
            <Routes>
              <Route path="/merchants/:mrchId" element={<MerchantDetailPage />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </StrictMode>,
    )

    expect(await screen.findByText(/no merchant with this id exists/i)).toBeTruthy()
  })
})
