import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { FulfillmentPage } from '../../src/features/fulfillment/FulfillmentPage.js'
import { BatchGeneratePage } from '../../src/features/fulfillment/generate/BatchGeneratePage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// P2-2/3/4: the object-spine screens over the P2-1 reads. The confirmed
// ops-edge contract (apps/ops-edge/src/ops-read.controller.ts, over
// services/fulfillment/src/ops-read.ts):
//   GET /ops/pool[?poolStatus=]      -> PoolEntryRow[]   (PII-free)
//   GET /ops/batches                 -> BatchRow[]       (newest first)
//   GET /ops/dispatches[?status=]    -> DispatchRow[]    (PII-free)
//   GET /ops/batches/:btchId         -> BatchDetailView | 404
// All guard-only: no Idempotency-Key, no step-up, no 6e.

interface Call {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const POOL_ROW = {
  asgnId: 'asgn_pool1',
  merchantDisplayName: 'BRILLIANT PERFUME',
  merchantLegalName: 'BRILLIANT PERFUME',
  bankReferenceCode: '1568',
  bankDisplayName: 'GSC BANK',
  branchCode: '30',
  soundbox: true,
  standeeCount: 1,
  stickerCount: 2,
  poolStatus: 'POOLED',
  dispatchState: null,
  shipToSuperseded: false,
  dispatchGroup: null,
  batch: null,
  createdAt: '2026-05-01T00:00:00.000Z',
}

const BATCH_ROW = {
  id: 'btch_abc',
  triggerReason: 'LOT_SIZE',
  unitCount: 42,
  printVndr: null,
  triggeredByActor: null,
  createdAt: '2026-05-02T00:00:00.000Z',
  updatedAt: '2026-05-02T00:00:00.000Z',
}

function stubFetch(handler: (url: string) => Response): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return handler(url)
    }),
  )
  return calls
}

function renderFulfillment() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <FulfillmentPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  clearAccessToken()
  setAccessToken('tok-1')
  vi.unstubAllGlobals()
})
afterEach(() => {
  cleanup()
})

describe('FulfillmentPage', () => {
  it('reads GET /ops/pool on mount and shows the pool inline, with nothing to click first', async () => {
    const calls = stubFetch(() => jsonResponse([POOL_ROW]))
    renderFulfillment()
    // 2026-08-17: the pool is ON the page. It used to sit behind a "View pool"
    // button that opened a dialog, which put the records an operator is
    // deciding about behind an overlay at the moment they decide.
    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /view pool/i })).toBeNull()
    expect(calls.some((c) => c.url.includes('/ops/pool'))).toBe(true)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBeUndefined()
  })

  it('the batches region calls GET /ops/batches and shows the stored unit count', async () => {
    const calls = stubFetch((url) => jsonResponse(url.includes('/ops/batches') ? [BATCH_ROW] : [POOL_ROW]))
    renderFulfillment()
    expect(await screen.findByText('btch_abc')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
    expect(calls.some((c) => c.url.includes('/ops/batches'))).toBe(true)
  })

  it('renders NO recipient PII, because the server projection carries none', async () => {
    // A server that wrongly leaked PII must still not have it rendered: the
    // columns are a fixed PII-free set, not a spread of whatever arrived.
    const leaky = { ...POOL_ROW, shipToAddress: 'PLOT 42 SECRET LANE', shipToMobile: '9537908017' }
    stubFetch(() => jsonResponse([leaky]))
    renderFulfillment()
    await screen.findByText('BRILLIANT PERFUME')
    expect(screen.queryByText(/PLOT 42 SECRET LANE/)).toBeNull()
    expect(screen.queryByText(/9537908017/)).toBeNull()
  })

  // Final review minor 2 (2026-08-11): spec 1.9 wants a dispatch group badge
  // in the pool view too, not only batch detail. The pool table had no
  // Dispatch ID cell at all before this fix; this test pins both the new
  // chip and the badge rule (SB for a SOUNDBOX row, nothing for a legacy row).
  it('shows the Dispatch ID chip with an SB badge on a SOUNDBOX row, and no badge on a legacy row', async () => {
    stubFetch(() =>
      jsonResponse([
        { ...POOL_ROW, asgnId: 'asgn_sb', merchantDisplayName: 'ALPHA TRADERS', dispatchGroup: 'SOUNDBOX' },
        { ...POOL_ROW, asgnId: 'asgn_legacy', merchantDisplayName: 'GAMMA TRADERS', dispatchGroup: null },
      ]),
    )
    renderFulfillment()
    await screen.findByText('ALPHA TRADERS')
    expect(await screen.findByText('asgn_sb')).toBeTruthy()
    expect(await screen.findByText('asgn_legacy')).toBeTruthy()
    expect(screen.getByText('SB')).toBeTruthy()
    expect(screen.getByLabelText('Soundbox dispatch')).toBeTruthy()
    // Only ONE badge span exists for two rows: the legacy row gets nothing.
    expect(screen.queryAllByText(/^(SB|COLL)$/)).toHaveLength(1)
  })
})

describe('FulfillmentPage navigation', () => {
  it('a batch id in the list links to that batch detail route', async () => {
    stubFetch((url) => jsonResponse(url.includes('/ops/batches') ? [BATCH_ROW] : [POOL_ROW]))
    renderFulfillment()
    // Batches is the default second card now, so the id renders without
    // opening the pool dialog.
    expect(await screen.findByRole('button', { name: 'btch_abc' })).toBeTruthy()
  })
})

// Spec 7.2: "Two regions on one page." The tab strip was the same shape
// principle 4 names as the defect and that the redesign had already removed
// from Uploads and Operations. Worse here, because the pending pool and the
// batches formed FROM it are two halves of one question.
// The old "two regions on one page" ruling has been relaxed 2026-08-14: the
// page opens on Ready to batch + Batches, and the pending pool is one click
// away in a dialog (users wanted the page not to be a long scroll of tables).
// The suite below still pins two things: no tab strip, and no shipments list.
describe('Batches: default landing, no tab strip', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  function stubBoth() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/ops/batches')) {
        return new Response(JSON.stringify([{
          id: 'btch_1', triggerReason: 'MANUAL', unitCount: 3,
          printVndr: null, triggeredByActor: null,
          createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
        }]), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
  }

  it('has no tab strip', async () => {
    stubBoth()
    renderFulfillment()
    await screen.findByText(/newest first\. open a batch/i)
    for (const gone of ['Pending Pool', 'Dispatches']) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull()
    }
  })

  it('opens on Build batch + Batches, with the pool itself on screen', async () => {
    stubBoth()
    renderFulfillment()
    expect(await screen.findByText(/newest first\. open a batch/i)).toBeTruthy()
    // The pool is inline now, so there is nothing to open and nothing to open it.
    expect(screen.queryByRole('button', { name: /view pool/i })).toBeNull()
    // No sidebar Card claiming to be the pool's own filter Toolbar.
    expect(screen.queryByLabelText(/pool status/i)).toBeNull()
  })

  // An empty pool used to say so TWICE in one card: "Nothing pooled yet" from
  // the inline grid, and "Nothing waiting to be batched" stacked directly
  // beneath it. Both branches read the same POOLED rows, so once the table came
  // out from behind its dialog they became the same condition. The grid owns
  // the message whenever it is on screen.
  it('says the pool is empty ONCE, not once per component that noticed', async () => {
    stubBoth()
    renderFulfillment()
    expect(await screen.findByText(/nothing pooled yet/i)).toBeTruthy()
    expect(screen.queryByText(/nothing waiting to be batched/i)).toBeNull()
  })

  it('no longer carries the shipments list, which moved to /dispatches', async () => {
    stubBoth()
    renderFulfillment()
    await screen.findByText(/newest first\. open a batch/i)
    expect(screen.queryByLabelText(/carrier status/i)).toBeNull()
  })
})

// `batch.status` is written once as 'BORN' by batching.ts and nothing anywhere
// updates it, so it had exactly one value for the life of every batch. The
// portal used to print it as a status beside a real timestamp ("BORN - formed
// 10 Aug"), which asserts a lifecycle the domain does not have. Adding the
// missing states would be inventing a state machine, so the portal stops
// claiming instead.
// Task 5: the derived Stage column. `deriveBatchStage`/`stagePill`/
// `stageSortRank` are exercised directly in batchStage.test.ts; this suite
// only pins the wiring: the summaries fetch is an enhancement (a Promise.all
// member that resolves to null on failure, never a page blocker), the chip
// and fraction render from it, and the default row order puts a batch that
// needs action ahead of one that is done.
describe('Batches: Stage column', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  const BATCH_PRINTING = {
    id: 'btch_print',
    triggerReason: 'LOT_SIZE',
    unitCount: 4,
    printVndr: null,
    triggeredByActor: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  }
  const BATCH_COMPLETE = {
    id: 'btch_complete',
    triggerReason: 'MANUAL',
    unitCount: 4,
    printVndr: null,
    triggeredByActor: null,
    createdAt: '2026-05-03T00:00:00.000Z',
    updatedAt: '2026-05-03T00:00:00.000Z',
  }
  const SUMMARY_PRINTING = {
    batchId: 'btch_print',
    counts: { total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 1, delivered: 0, activated: 0 },
    activation: { notRequested: null, requested: null, activated: 0 },
  }
  const SUMMARY_COMPLETE = {
    batchId: 'btch_complete',
    counts: { total: 4, deliverableAndActivatable: 4, sentToVendor: 4, dispatched: 4, delivered: 4, activated: 4 },
    activation: { notRequested: null, requested: null, activated: 4 },
  }

  function stubWithSummaries(summariesStatus = 200) {
    return stubFetch((url) => {
      if (url.includes('/ops/reports/batch-journey')) {
        return summariesStatus === 200
          ? jsonResponse({ rows: [SUMMARY_PRINTING, SUMMARY_COMPLETE], watermark: { asOf: null, perTopic: {} } })
          : jsonResponse({ message: 'boom' }, summariesStatus)
      }
      // API order deliberately puts the COMPLETE batch first: the sort under
      // test has to reorder it, not merely preserve server order.
      if (url.includes('/ops/batches')) return jsonResponse([BATCH_COMPLETE, BATCH_PRINTING])
      return jsonResponse([])
    })
  }

  it('renders the stage chip and fraction from the batch-journey summaries', async () => {
    stubWithSummaries()
    renderFulfillment()
    expect(await screen.findByText('Needs return sheet')).toBeTruthy()
    expect(await screen.findByText('Complete')).toBeTruthy()
    expect(await screen.findByText('1/4')).toBeTruthy()
  })

  it('sorts a PRINTING batch above a COMPLETE one by default, regardless of API order', async () => {
    stubWithSummaries()
    renderFulfillment()
    await screen.findByText('Needs return sheet')
    const ids = screen.getAllByRole('button', { name: /^btch_/ }).map((el) => el.textContent)
    expect(ids.indexOf('btch_print')).toBeLessThan(ids.indexOf('btch_complete'))
  })

  it('still renders the batch list fully when the batch-journey summaries call fails', async () => {
    stubWithSummaries(500)
    renderFulfillment()
    expect(await screen.findByRole('button', { name: 'btch_print' })).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'btch_complete' })).toBeTruthy()
    // No chip, because the enhancement failed; the base row still renders.
    expect(screen.queryByText('Needs return sheet')).toBeNull()
  })

  // 2026-08-18 fix: getBatchJourneySummaries is an audited cross-tenant full
  // scan. It must not ride the 8s poll (usePagePoll's steady interval,
  // usePagePoll.ts) the way the pool/batches reads do; it refetches only on
  // mount, on the tab regaining visibility, and after a manual batch trigger.
  it('does not refetch batch-journey summaries on the 8s poll tick, but does on a visibilitychange to visible', async () => {
    vi.useFakeTimers()
    try {
      const calls = stubWithSummaries()
      renderFulfillment()

      // Mount fetch: exactly one summaries read.
      await vi.waitFor(() => {
        expect(calls.filter((c) => c.url.includes('/ops/reports/batch-journey')).length).toBe(1)
      })
      const summaryCallCount = () => calls.filter((c) => c.url.includes('/ops/reports/batch-journey')).length
      const poolBatchCallCount = () => calls.filter((c) => c.url.includes('/ops/batches') && !c.url.includes('/ops/reports/')).length

      const poolCallsBefore = poolBatchCallCount()

      // Advance past the settle burst (2s, 4s) and a full 8s interval tick:
      // the pool/batches read fires again (usePagePoll's whole job), but
      // summaries must stay at exactly the one mount fetch.
      await vi.advanceTimersByTimeAsync(8_100)
      expect(poolBatchCallCount()).toBeGreaterThan(poolCallsBefore)
      expect(summaryCallCount()).toBe(1)

      // The tab becomes visible again: summaries refetch, outside the poll.
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      expect(summaryCallCount()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Batches: a constant is not a status', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  it('the batch list has no Status column', async () => {
    stubFetch((url) => jsonResponse(url.includes('/ops/batches') ? [BATCH_ROW] : []))
    renderFulfillment()
    expect(await screen.findByRole('columnheader', { name: 'Trigger' })).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull()
  })

  // Retargeted 13 Aug 2026: the batch page is now the collateral generator, and
  // the invariant travels with it. What is under test is that the page states an
  // instant it can prove rather than a constant posing as a lifecycle.
  it('the batch page states when it formed, not a word that never changes', async () => {
    // The journey read is answered with a 500 here: this test only cares
    // about the Formed fact, and the page's own failure handling turns a
    // failed journey fetch into "no rail" rather than a crash.
    stubFetch((url) =>
      url.includes('/ops/reports/batch-journey/')
        ? jsonResponse({ message: 'boom' }, 500)
        : jsonResponse({ batch: BATCH_ROW, entries: [], artifacts: [], printLayout: 'ONE_PER_PAGE' }),
    )
    render(
      <MemoryRouter
        initialEntries={['/batches/btch_abc']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          <Routes>
            <Route path="/batches/:btchId" element={<BatchGeneratePage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(/^Formed$/i)).toBeTruthy()
    expect(screen.queryByText(/BORN/)).toBeNull()
  })
})
