import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
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
  status: 'BATCHED',
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
  // THE POOL IS NOT ON THIS PAGE ANY MORE (18 Aug 2026, decision D14). It moved
  // to /pool, with its own request-grain table and its own tests
  // (test/features/pool.test.tsx). This assertion is the guard against it
  // drifting back: two pages both showing the queue is how the batches page got
  // to be two pages' worth of work in the first place.
  it('does not read or render the pool, which lives at /pool now', async () => {
    const calls = stubFetch((url) => jsonResponse(url.includes('/ops/batches') ? [BATCH_ROW] : []))
    renderFulfillment()
    await screen.findByText('btch_abc')
    expect(calls.some((c) => c.url.includes('/ops/pool'))).toBe(false)
    expect(screen.queryByText(/build batch/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /create trigger/i })).toBeNull()
  })

  it('the batches region calls GET /ops/batches and shows the stored unit count', async () => {
    const calls = stubFetch((url) => jsonResponse(url.includes('/ops/batches') ? [BATCH_ROW] : [POOL_ROW]))
    renderFulfillment()
    expect(await screen.findByText('btch_abc')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
    expect(calls.some((c) => c.url.includes('/ops/batches'))).toBe(true)
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

// What this page is, and is not. It carried a tab strip once, then two regions,
// then the pool inline; as of 18 Aug 2026 (decision D14) it is the batches and
// nothing else, and the suite pins the things that have each been wrong before:
// no tab strip, no shipments list, no pool.
describe('Batches: the page is the batches and nothing else', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  function stubBoth() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/ops/batches')) {
        return new Response(JSON.stringify([{
          id: 'btch_1', status: 'BATCHED', triggerReason: 'MANUAL', unitCount: 3,
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

  it('opens straight on the batches list', async () => {
    stubBoth()
    renderFulfillment()
    expect(await screen.findByText(/newest first\. open a batch/i)).toBeTruthy()
    // Nothing to open and nothing to open it with: no pool dialog, no pool
    // filter, no pool at all.
    expect(screen.queryByRole('button', { name: /view pool/i })).toBeNull()
    expect(screen.queryByLabelText(/pool status/i)).toBeNull()
  })

  it('says no batches have formed rather than rendering a bare table', async () => {
    // No batches at all, which is a different empty state from "none match your
    // filters": the page distinguishes them because the fix for each is different.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })),
    )
    renderFulfillment()
    expect(await screen.findByText(/no batches have formed yet/i)).toBeTruthy()
    // The pool's own empty state belongs to /pool now, not here.
    expect(screen.queryByText(/nothing pooled yet/i)).toBeNull()
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
// THIS SUITE USED TO SAY THE OPPOSITE, and the reversal is the point.
//
// It was written when batch.status had been dropped: the column was
// write-once-read-never, every batch held the same word, and a pill showing one
// constant to everybody says nothing, so the right assertion then was that no
// Status column exists.
//
// As of 18 Aug 2026 a batch has a real three-state lifecycle with three named
// writers (BATCHED by the trigger, SENT_TO_PRINT_VENDOR by the send action,
// CLOSED by the close action), so the status now distinguishes batches from each
// other and is what the list filters on. The pin flips to guard the new
// contract: the column exists AND it renders the server's value, not a constant.
describe('Batches: the status is a real lifecycle now', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  it('the batch list has a Status column carrying the value the server sent', async () => {
    stubFetch((url) => jsonResponse(url.includes('/ops/batches') ? [BATCH_ROW] : []))
    renderFulfillment()
    expect(await screen.findByRole('columnheader', { name: 'Trigger' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeTruthy()
    // BATCH_ROW is BATCHED, and statusMeta renders that as "Batched". Scoped to
    // the ROW, because the word is deliberately on screen twice: the tile band
    // above counts batches by status and labels one of its tiles the same thing.
    const row = screen.getByRole('row', { name: new RegExp(BATCH_ROW.id) })
    expect(within(row).getByText('Batched')).toBeTruthy()
  })

  it('offers Send to print vendor on a BATCHED batch, the one state it is legal in', async () => {
    stubFetch((url) => jsonResponse(url.includes('/ops/batches') ? [BATCH_ROW] : []))
    renderFulfillment()
    expect(await screen.findByRole('button', { name: /send batch .* to the print vendor/i })).toBeTruthy()
  })

  it('offers no send control once the batch has already been sent', async () => {
    stubFetch((url) =>
      jsonResponse(url.includes('/ops/batches') ? [{ ...BATCH_ROW, status: 'SENT_TO_PRINT_VENDOR' }] : []),
    )
    renderFulfillment()
    // The status has to be on screen before the absence of the button means
    // anything: asserting on an empty grid would pass for the wrong reason.
    expect(await screen.findByText('Sent to print vendor')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /send batch .* to the print vendor/i })).toBeNull()
  })

  // Retargeted 13 Aug 2026: the batch page is now the collateral generator, and
  // the invariant travels with it. What is under test is that the page states an
  // instant it can prove rather than a constant posing as a lifecycle.
  it('the batch page states when it formed, not a word that never changes', async () => {
    stubFetch(() => jsonResponse({ batch: BATCH_ROW, entries: [], artifacts: [], printLayout: 'ONE_PER_PAGE' }))
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
