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

const ROWS = [
  {
    mrchId: 'mrch_2a',
    displayName: 'Kirana Corner',
    legalName: 'KIRANA CORNER PRIVATE LIMITED',
    mcc: '5411',
    status: 'ACTIVE',
    updatedAt: '2026-08-01T10:00:00.000Z',
  },
  {
    mrchId: 'mrch_2b',
    displayName: 'Tea Stall Junction',
    legalName: 'TEA STALL JUNCTION LLP',
    mcc: '5812',
    status: 'SUSPENDED',
    updatedAt: '2026-08-02T10:00:00.000Z',
  },
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
    await userEvent.type(screen.getByPlaceholderText(/name, legal name/i), 'tea')
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
  // identity, contact and the dispatch address block. The POST body is the
  // contract the backend team implements; nothing typed may silently vanish
  // from it.
  it('posts every BRD field from the Add merchant form, and stays disabled until they are valid', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/merchants') && init.method === 'POST') return jsonResponse({ mrchId: 'mrch_new' })
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
