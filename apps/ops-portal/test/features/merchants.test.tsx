import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { MerchantsPage } from '../../src/features/merchants/MerchantsPage.js'
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
    const fetchMock = vi.fn(async () => jsonResponse(ROWS))
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

  it('filters client-side and says how many of the total are showing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ROWS)))
    renderPage()
    await screen.findByText('Kirana Corner')
    expect(screen.getByText('2 merchants')).toBeTruthy()

    await userEvent.type(screen.getByLabelText('Search'), 'tea')
    expect(screen.queryByText('Kirana Corner')).toBeNull()
    expect(screen.getByText('Tea Stall Junction')).toBeTruthy()
    // The count must name the narrowing, so a filtered view cannot be mistaken
    // for the whole merchant master.
    expect(screen.getByText('1 of 2 merchants')).toBeTruthy()
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
})
