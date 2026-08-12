import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { FulfillmentPage } from '../../src/features/fulfillment/FulfillmentPage.js'
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

// The BatchDetailPage suite is GONE with the page it covered (2026-08-12).
// That page was a Summary tile plus per-type PDF download buttons, and
// /batches/:btchId now renders BatchGeneratePage instead: one batch page, the
// one that actually previews cards, renders the print run and hands over the
// Excel. Its three Summary facts moved into the generate page's header, and the
// per-type PDF downloads were deliberately dropped (they were bare QRs with no
// card design, and they sat below the Excel where the final output belongs).
// BRD FR-08. A damage replacement is a normal pooled record in every respect
// that matters to batching (same pool, same trigger, same collateral), which is
// correct but leaves the records table unable to say WHY a merchant appears
// twice. The parent linkage already existed server-side on
// assignment.replacement_of and GET /ops/damage-cases already exposed it; the
// portal simply never asked.
describe('FulfillmentPage: damage replacements name the dispatch they replace', () => {
  const DAMAGE_CASE = {
    asgnId: 'asgn_pool1', // the same asgnId POOL_ROW carries
    replacementOf: 'asgn_originaldispatchid0001',
    merchantDisplayName: 'BRILLIANT PERFUME',
    bankReferenceCode: '1568',
    branchCode: '30',
    damageReason: 'battery issue',
    bankRemarks: 'will not hold charge',
    caseStatus: 'Open',
    billable: false,
    demandState: 'pooled-for-fulfillment',
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  }

  function stubWithDamage(cases: unknown) {
    return stubFetch((url) => {
      if (url.includes('/ops/damage-cases')) return jsonResponse(cases)
      if (url.includes('/ops/batches')) return jsonResponse([])
      if (url.includes('/ops/pool')) return jsonResponse([POOL_ROW])
      return jsonResponse([])
    })
  }

  it('labels a replacement row and names its parent dispatch and reason', async () => {
    stubWithDamage([DAMAGE_CASE])
    renderFulfillment()
    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(await screen.findByText(/replacement/i)).toBeTruthy()
    expect(screen.getByText(/battery issue/)).toBeTruthy()
    expect(screen.getByText(/non-billable/)).toBeTruthy()
  })

  it('leaves an ordinary pooled row completely undecorated', async () => {
    stubWithDamage([])
    renderFulfillment()
    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(screen.queryByText(/replacement/i)).toBeNull()
  })

  // The decoration must never be able to cost the table. A case row that names
  // no parent, or a non-array body, has to degrade to the plain merchant name.
  it('renders the plain name when the damage read is malformed', async () => {
    stubWithDamage({ code: 'boom' })
    renderFulfillment()
    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(screen.queryByText(/replacement/i)).toBeNull()
  })

  it('renders the plain name when a case names no parent', async () => {
    stubWithDamage([{ ...DAMAGE_CASE, replacementOf: undefined }])
    renderFulfillment()
    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(screen.queryByText(/replacement/i)).toBeNull()
  })
})

describe('FulfillmentPage navigation', () => {
  // The row's ONE control. The batch id used to be a button to the same place,
  // so a row carried two controls leading to one destination, and the id landed
  // on the weaker of the two batch pages that then existed.
  it('offers a single explicit control into the batch, not a clickable id', async () => {
    stubFetch((url) => jsonResponse(url.includes('/ops/batches') ? [BATCH_ROW] : [POOL_ROW]))
    renderFulfillment()
    await screen.findByText('BRILLIANT PERFUME')
    expect(await screen.findByRole('button', { name: /generate collateral/i })).toBeTruthy()
    // The id is still ON the row, as text to read and copy, just not a control.
    expect(screen.getByText('btch_abc')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'btch_abc' })).toBeNull()
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
    await screen.findByText(/2\. Records/i)
    for (const gone of ['Pending Pool', 'Dispatches']) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull()
    }
  })

  it('shows the pool and the batches at the same time, not one at a time', async () => {
    stubBoth()
    renderFulfillment()
    // Both region headings are on screen together.
    expect(await screen.findByText(/every committed row and where it has reached/i)).toBeTruthy()
    expect(screen.getByText(/newest first\. generate opens the collateral page/i)).toBeTruthy()
  })

  it('no longer carries the shipments list, which moved to /dispatches', async () => {
    stubBoth()
    renderFulfillment()
    await screen.findByText(/2\. Records/i)
    expect(screen.queryByLabelText(/carrier status/i)).toBeNull()
  })
})

// `batch.status` is written once as 'BORN' by batching.ts and nothing anywhere
// updates it, so it had exactly one value for the life of every batch. The
// portal used to print it as a status beside a real timestamp ("BORN - formed
// 10 Aug"), which asserts a lifecycle the domain does not have. Adding the
// missing states would be inventing a state machine, so the portal stops
// claiming instead.
describe('Batches: a constant is not a status', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  it('the batch list has no Status column', async () => {
    stubFetch((url) => jsonResponse(url.includes('/ops/batches') ? [BATCH_ROW] : []))
    renderFulfillment()
    expect(await screen.findByRole('columnheader', { name: 'Trigger' })).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull()
  })

  // The batch LIST's own claim. The companion assertion, that a batch page states
  // when it formed rather than a status word that never changes, moved with the
  // detail page it covered: /batches/:btchId is BatchGeneratePage now, and its
  // header carries Formed alongside Trigger.
  it('states the trigger, never the never-changing status word', async () => {
    stubFetch((url) => jsonResponse(url.includes('/ops/batches') ? [BATCH_ROW] : []))
    renderFulfillment()
    expect(await screen.findByText('LOT_SIZE')).toBeTruthy()
    expect(screen.queryByText(/BORN/)).toBeNull()
  })
})
