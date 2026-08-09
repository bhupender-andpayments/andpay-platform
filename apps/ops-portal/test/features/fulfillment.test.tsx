import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { FulfillmentPage } from '../../src/features/fulfillment/FulfillmentPage.js'
import { BatchDetailPage } from '../../src/features/fulfillment/BatchDetailPage.js'
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
  batch: null,
  createdAt: '2026-05-01T00:00:00.000Z',
}

const BATCH_ROW = {
  id: 'btch_abc',
  status: 'BORN',
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

function renderBatchDetail(btchId: string) {
  return render(
    <MemoryRouter
      initialEntries={[`/batches/${btchId}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AuthProvider>
        <Routes>
          <Route path="/batches/:btchId" element={<BatchDetailPage />} />
        </Routes>
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
  it('lands on the pending pool and lists it from GET /ops/pool', async () => {
    const calls = stubFetch(() => jsonResponse([POOL_ROW]))
    renderFulfillment()
    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(calls.some((c) => c.url.includes('/ops/pool'))).toBe(true)
    // Guard-only read: no Idempotency-Key on a GET.
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBeUndefined()
  })

  it('sends ?poolStatus when the pool filter is narrowed', async () => {
    const calls = stubFetch(() => jsonResponse([POOL_ROW]))
    renderFulfillment()
    await screen.findByText('BRILLIANT PERFUME')
    await userEvent.selectOptions(screen.getByLabelText('Pool status'), 'HELD')
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('poolStatus=HELD'))).toBe(true)
    })
  })

  it('the batches region calls GET /ops/batches and shows the stored unit count', async () => {
    const calls = stubFetch((url) => jsonResponse(url.includes('/ops/batches') ? [BATCH_ROW] : [POOL_ROW]))
    renderFulfillment()
    await screen.findByText('BRILLIANT PERFUME')
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
})

describe('BatchDetailPage', () => {
  it('shows the summary, the records, and only the downloads that exist', async () => {
    stubFetch(() =>
      jsonResponse({
        batch: BATCH_ROW,
        entries: [
          {
            asgnId: 'asgn_1',
            // Display and legal names deliberately DIFFER: they are separate
            // columns, and identical values would make a name assertion
            // ambiguous about which column it proved.
            merchantDisplayName: 'BRILLIANT PERFUME',
            merchantLegalName: 'BRILLIANT PERFUME PVT LTD',
            bankReferenceCode: '1568',
            bankDisplayName: 'GSC BANK',
            branchCode: '30',
            soundbox: true,
            standeeCount: 1,
            stickerCount: 2,
            poolStatus: 'BATCHED',
            dispatchState: null,
            shipToSuperseded: false,
          },
        ],
        artifacts: [{ asgnId: 'asgn_1', artifactType: 'STANDEE_IMG', assetReference: 'ref-1', supersededAt: null }],
      }),
    )
    renderBatchDetail('btch_abc')
    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
    // The batch HAS a standee artifact, so that download is offered...
    expect(screen.getByRole('button', { name: /Standee PDF/ })).toBeTruthy()
    // ...and the two types it does NOT have are not offered at all.
    expect(screen.queryByRole('button', { name: /Sticker PDF/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Soundbox PDF/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Dispatch sheet/ })).toBeTruthy()
  })

  it('shows a no-such-batch empty state on a 404 rather than a generic error', async () => {
    stubFetch(() => jsonResponse({ message: 'batch not found' }, 404))
    renderBatchDetail('btch_missing')
    expect(await screen.findByText('No such batch')).toBeTruthy()
  })

  it('offers no collateral downloads when the batch has composed none', async () => {
    stubFetch(() => jsonResponse({ batch: BATCH_ROW, entries: [], artifacts: [] }))
    renderBatchDetail('btch_abc')
    expect(await screen.findByText(/No collateral has been composed/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /PDF/ })).toBeNull()
  })
})

describe('FulfillmentPage navigation', () => {
  it('a batch id in the list links to that batch detail route', async () => {
    stubFetch((url) => jsonResponse(url.includes('/ops/batches') ? [BATCH_ROW] : [POOL_ROW]))
    renderFulfillment()
    await screen.findByText('BRILLIANT PERFUME')
    // Two tables on screen now (pool and batches), so the batch link is found
    // directly rather than by assuming there is only one table.
    expect(await screen.findByRole('button', { name: 'btch_abc' })).toBeTruthy()
  })
})

// Spec 7.2: "Two regions on one page." The tab strip was the same shape
// principle 4 names as the defect and that the redesign had already removed
// from Uploads and Operations. Worse here, because the pending pool and the
// batches formed FROM it are two halves of one question.
describe('Batches: two regions, no tab strip', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  function stubBoth() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/ops/batches')) {
        return new Response(JSON.stringify([{
          id: 'btch_1', status: 'BORN', triggerReason: 'MANUAL', unitCount: 3,
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
    await screen.findByText(/pending pool/i)
    for (const gone of ['Pending Pool', 'Dispatches']) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull()
    }
  })

  it('shows the pool and the batches at the same time, not one at a time', async () => {
    stubBoth()
    renderFulfillment()
    // Both region headings are on screen together.
    expect(await screen.findByText(/records awaiting batching/i)).toBeTruthy()
    expect(screen.getByText(/newest first\. select a batch/i)).toBeTruthy()
  })

  it('no longer carries the shipments list, which moved to /dispatches', async () => {
    stubBoth()
    renderFulfillment()
    await screen.findByText(/pending pool/i)
    expect(screen.queryByLabelText(/carrier status/i)).toBeNull()
  })
})
