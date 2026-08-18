import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { ToastProvider } from '../../src/ui/Toast.js'
import { PoolPage, groupByRequest } from '../../src/features/fulfillment/PoolPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'
import type { PoolEntryRow } from '../../src/api/endpoints.js'

// THE POOL, its own section since 18 Aug 2026 (decision D14), and its own grain.
//
// These tests moved here from fulfillment.test.tsx when the pool moved off the
// batches page, and the grain assertions are new: the table shows one row per
// MERCHANT REQUEST rather than one per dispatch, because the minimum-lot
// threshold counts requests and a table counting dispatches could tell an
// operator "40 of 20" for twenty requests.

function entry(over: Partial<PoolEntryRow> = {}): PoolEntryRow {
  return {
    asgnId: 'asgn_1',
    dispatchGroup: null,
    sourceEventId: 'file-1|1',
    merchantDisplayName: 'BRILLIANT PERFUME',
    merchantLegalName: 'BRILLIANT PERFUME PVT LTD',
    bankReferenceCode: '3',
    bankDisplayName: 'GSCB',
    branchCode: '30',
    soundbox: true,
    standeeCount: 1,
    stickerCount: 2,
    poolStatus: 'POOLED',
    dispatchState: null,
    shipToSuperseded: false,
    batch: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    tenantId: 'tnnt_1',
    programId: 'prog_1',
    ...over,
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

interface Call {
  url: string
  init: RequestInit
}

/** Answers the pool read per poolStatus, so the Held tab can be driven too. */
function stubPool(pooled: PoolEntryRow[], held: PoolEntryRow[] = []): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('poolStatus=HELD')) return jsonResponse(held)
      if (url.includes('/ops/pool')) return jsonResponse(pooled)
      return jsonResponse([])
    }),
  )
  return calls
}

function renderPool() {
  return render(
    <MemoryRouter initialEntries={['/pool']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route path="/pool" element={<PoolPage />} />
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('groupByRequest', () => {
  it('folds the two dispatch groups of one bank row into ONE request', () => {
    const rows = groupByRequest([
      entry({ asgnId: 'asgn_sb', sourceEventId: 'file-1|1', dispatchGroup: 'SOUNDBOX', soundbox: true, standeeCount: 0, stickerCount: 0 }),
      entry({ asgnId: 'asgn_coll', sourceEventId: 'file-1|1', dispatchGroup: 'COLLATERAL', soundbox: false, standeeCount: 1, stickerCount: 2 }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.dispatches).toBe(2)
    // The kit is the whole REQUEST's kit, summed across its parcels: what the
    // merchant asked for, which is the question the row answers.
    expect(rows[0]!.soundbox).toBe(true)
    expect(rows[0]!.standeeCount).toBe(1)
    expect(rows[0]!.stickerCount).toBe(2)
  })

  it('keeps genuinely separate requests separate', () => {
    const rows = groupByRequest([
      entry({ asgnId: 'a', sourceEventId: 'file-1|1' }),
      entry({ asgnId: 'b', sourceEventId: 'file-1|2' }),
    ])
    expect(rows).toHaveLength(2)
  })

  it('falls back to one request per dispatch when the server sends no request key', () => {
    // An older server that predates the projection. One row per dispatch is the
    // pre-split meaning and the safe direction to be wrong in: it never reports
    // a lot as readier than it is.
    const rows = groupByRequest([
      entry({ asgnId: 'a', sourceEventId: undefined }),
      entry({ asgnId: 'b', sourceEventId: undefined }),
    ])
    expect(rows).toHaveLength(2)
  })

  it('dates the request by its EARLIEST dispatch, which is how long it has waited', () => {
    const rows = groupByRequest([
      entry({ asgnId: 'a', sourceEventId: 'f|1', createdAt: '2026-08-05T00:00:00.000Z' }),
      entry({ asgnId: 'b', sourceEventId: 'f|1', createdAt: '2026-08-01T00:00:00.000Z' }),
    ])
    expect(rows[0]!.pooledAt).toBe('2026-08-01T00:00:00.000Z')
  })

  it("counts how many of a request's dispatches are held", () => {
    const rows = groupByRequest([
      entry({ asgnId: 'a', sourceEventId: 'f|1', poolStatus: 'HELD' }),
      entry({ asgnId: 'b', sourceEventId: 'f|1', poolStatus: 'POOLED' }),
    ])
    expect(rows[0]!.heldCount).toBe(1)
  })
})

describe('PoolPage', () => {
  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  it('reads the pool on mount, both POOLED and HELD, with no idempotency key on a read', async () => {
    const calls = stubPool([entry()])
    renderPool()
    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(calls.some((c) => c.url.includes('poolStatus=POOLED'))).toBe(true)
    // HELD had no surface anywhere before this page: the endpoint supported the
    // filter and nothing asked for it, so a held dispatch could not be found
    // again, let alone released.
    expect(calls.some((c) => c.url.includes('poolStatus=HELD'))).toBe(true)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBeUndefined()
  })

  it('renders ONE row for a request that minted two dispatches, and no Dispatch ID column', async () => {
    stubPool([
      entry({ asgnId: 'asgn_sb', sourceEventId: 'file-1|1', dispatchGroup: 'SOUNDBOX' }),
      entry({ asgnId: 'asgn_coll', sourceEventId: 'file-1|1', dispatchGroup: 'COLLATERAL' }),
    ])
    renderPool()
    await screen.findByText('BRILLIANT PERFUME')
    // A request has one or two dispatch ids, so a single cell would either lie or
    // hold a list. The count is the honest summary; the ids are in the dialog.
    expect(screen.queryByRole('columnheader', { name: 'Dispatch ID' })).toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Dispatches' })).toBeTruthy()
    expect(screen.queryByText('asgn_sb')).toBeNull()
  })

  it('opens the request to show its dispatches, each with its own hold control', async () => {
    stubPool([
      entry({ asgnId: 'asgn_sb', sourceEventId: 'file-1|1', dispatchGroup: 'SOUNDBOX' }),
      entry({ asgnId: 'asgn_coll', sourceEventId: 'file-1|1', dispatchGroup: 'COLLATERAL' }),
    ])
    renderPool()
    await userEvent.click(await screen.findByText('BRILLIANT PERFUME'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('asgn_sb')).toBeTruthy()
    expect(within(dialog).getByText('asgn_coll')).toBeTruthy()
    // Holding is per PARCEL, so there is one control per dispatch, not one for
    // the request.
    expect(within(dialog).getAllByRole('button', { name: /hold/i })).toHaveLength(2)
  })

  it('marks a partially held request on its row, because it still counts toward the lot', async () => {
    stubPool([
      entry({ asgnId: 'asgn_sb', sourceEventId: 'file-1|1', poolStatus: 'HELD' }),
      entry({ asgnId: 'asgn_coll', sourceEventId: 'file-1|1', poolStatus: 'POOLED' }),
    ])
    renderPool()
    // The server counts the REQUEST while any of its parcels is pooled, so the
    // row has to say why the numbers look the way they do.
    expect(await screen.findByText(/1 of 2 on hold/i)).toBeTruthy()
  })

  it('renders NO recipient PII, because the server projection carries none', async () => {
    // A server that wrongly leaked PII must still not have it rendered: the
    // columns are a fixed PII-free set, not a spread of whatever arrived.
    const leaky = { ...entry(), shipToAddress: 'PLOT 42 SECRET LANE', shipToMobile: '9537908017' }
    stubPool([leaky as PoolEntryRow])
    renderPool()
    await screen.findByText('BRILLIANT PERFUME')
    expect(screen.queryByText(/PLOT 42 SECRET LANE/)).toBeNull()
    expect(screen.queryByText(/9537908017/)).toBeNull()
  })

  it('offers a Held view that names why each dispatch is held', async () => {
    stubPool([], [entry({ asgnId: 'asgn_held', poolStatus: 'HELD', holdReason: 'merchant asked us to wait' })])
    renderPool()
    await userEvent.click(await screen.findByRole('button', { name: /held \(1\)/i }))
    // Scoped to the ROW: DataGrid renders each cell's text in the cell and again
    // in its column-resize measuring span, so an unscoped query finds two.
    // getAllByText, not getByText: DataGrid renders each cell's text twice, once
    // in the cell and once in the hidden span it measures column widths with.
    expect((await screen.findAllByText(/merchant asked us to wait/i)).length).toBeGreaterThan(0)
    // Release is the way back, and it is the whole reason this view exists.
    expect(screen.getByRole('button', { name: /release/i })).toBeTruthy()
  })

  it('says nothing is on hold rather than rendering a bare table', async () => {
    stubPool([entry()], [])
    renderPool()
    await userEvent.click(await screen.findByRole('button', { name: /held \(0\)/i }))
    expect(await screen.findByText(/nothing is on hold/i)).toBeTruthy()
  })
})
