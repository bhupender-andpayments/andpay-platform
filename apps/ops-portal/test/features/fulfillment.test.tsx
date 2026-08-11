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
  dispatchGroup: null,
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
            dispatchGroup: null,
          },
        ],
        artifacts: [{ asgnId: 'asgn_1', artifactType: 'STANDEE_IMG', assetReference: 'ref-1', supersededAt: null }],
        printLayout: 'ONE_PER_PAGE',
      }),
    )
    renderBatchDetail('btch_abc')
    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
    // The batch HAS a standee artifact, so the COLLATERAL download is offered.
    // The buttons are the two DELIVERY GROUPS the print vendor is handed, not
    // the three stored artifact types: there is no per-type PDF any more.
    expect(screen.getByRole('button', { name: /Collateral PDF/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Standee PDF/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Sticker PDF/ })).toBeNull()
    // and the group it has nothing for is not offered at all.
    expect(screen.queryByRole('button', { name: /Soundbox PDF/ })).toBeNull()
    // The single dispatch-sheet button is gone: this entry has soundbox true
    // AND standeeCount 1, so it belongs to BOTH excel groups, and both Excel
    // buttons render.
    expect(screen.getByRole('button', { name: /Soundbox Excel/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Collateral Excel/ })).toBeTruthy()
    // Task 14 (W-6): the bound print vendor's layout, named near the
    // downloads so an operator knows what shape a PDF will actually be.
    expect(screen.getByText('Layout: one per page')).toBeTruthy()
  })

  // Task 14 (W-6): the same line, naming the OTHER layout. Read straight off
  // detail.printLayout, never inferred from the vendor id, so this stays
  // correct even if the operator has never opened the vendor admin screen.
  it('names the layout as "3x2 grid" when the bound vendor is set to GRID_3X2', async () => {
    stubFetch(() =>
      jsonResponse({
        batch: BATCH_ROW,
        entries: [],
        artifacts: [],
        printLayout: 'GRID_3X2',
      }),
    )
    renderBatchDetail('btch_abc')
    expect(await screen.findByText('Layout: 3x2 grid')).toBeTruthy()
    expect(screen.queryByText('Layout: one per page')).toBeNull()
  })

  // Excel gating is LINE membership off detail.entries, never artifact
  // presence: an orphan line (no soundbox, no standee, no sticker) still gets
  // a row on the Collateral sheet, spec 2.2, even though nothing was ever
  // composed for it and detail.artifacts is empty.
  it('offers a Collateral Excel for an orphan-only batch even with zero artifacts', async () => {
    stubFetch(() =>
      jsonResponse({
        batch: BATCH_ROW,
        entries: [
          {
            asgnId: 'asgn_1',
            merchantDisplayName: 'BRILLIANT PERFUME',
            merchantLegalName: 'BRILLIANT PERFUME PVT LTD',
            bankReferenceCode: '1568',
            bankDisplayName: 'GSC BANK',
            branchCode: '30',
            soundbox: false,
            standeeCount: 0,
            stickerCount: 0,
            poolStatus: 'BATCHED',
            dispatchState: null,
            shipToSuperseded: false,
            dispatchGroup: null,
          },
        ],
        artifacts: [],
      }),
    )
    renderBatchDetail('btch_abc')
    expect(await screen.findByRole('button', { name: /Collateral Excel/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Soundbox Excel/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Soundbox PDF/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Collateral PDF/ })).toBeNull()
  })

  // The two-PDF delivery grouping. A merchant wanting both a sticker and a
  // standee is ONE page of shared artwork in ONE collateral PDF, so the screen
  // must offer ONE button: two would imply two documents that do not exist.
  it('renders exactly ONE Collateral button for a batch holding BOTH sticker and standee artifacts', async () => {
    const calls = stubFetch((url) =>
      url.includes('/collateral/')
        ? new Response('', { status: 404 })
        : jsonResponse({
            batch: BATCH_ROW,
            entries: [],
            artifacts: [
              { asgnId: 'asgn_1', artifactType: 'STANDEE_IMG', assetReference: 'ref-1', supersededAt: null },
              { asgnId: 'asgn_1', artifactType: 'STICKER_IMG', assetReference: 'ref-2', supersededAt: null },
              { asgnId: 'asgn_2', artifactType: 'STICKER_IMG', assetReference: 'ref-3', supersededAt: null },
            ],
          }),
    )
    renderBatchDetail('btch_abc')
    const buttons = await screen.findAllByRole('button', { name: /Collateral PDF/ })
    expect(buttons).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /Soundbox PDF/ })).toBeNull()

    // and it fetches the GROUP, not an artifact type.
    await userEvent.click(buttons[0]!)
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/collateral/COLLATERAL'))).toBe(true)
    })
    expect(calls.some((c) => /\/collateral\/(STANDEE_IMG|STICKER_IMG)/.test(c.url))).toBe(false)
  })

  it('renders the Soundbox button, hitting /collateral/SOUNDBOX, for a batch with soundbox artifacts', async () => {
    const calls = stubFetch((url) =>
      url.includes('/collateral/')
        ? new Response('', { status: 404 })
        : jsonResponse({
            batch: BATCH_ROW,
            entries: [],
            artifacts: [
              { asgnId: 'asgn_1', artifactType: 'SOUNDBOX_IMG', assetReference: 'ref-1', supersededAt: null },
              { asgnId: 'asgn_1', artifactType: 'STANDEE_IMG', assetReference: 'ref-2', supersededAt: null },
            ],
          }),
    )
    renderBatchDetail('btch_abc')
    // Both groups exist here, so both buttons appear: at most two, never three.
    const soundbox = await screen.findByRole('button', { name: /Soundbox PDF/ })
    expect(screen.getByRole('button', { name: /Collateral PDF/ })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /PDF/ })).toHaveLength(2)

    await userEvent.click(soundbox)
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/collateral/SOUNDBOX'))).toBe(true)
    })
    // a 404 is a legitimate empty, reported as a note rather than an error.
    expect(await screen.findByText(/No Soundbox collateral exists/)).toBeTruthy()
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

  // Task 11 (2026-08-11 dispatch-group split): the badge beside the Dispatch
  // ID. A NULL dispatchGroup is a legacy, pre-split combined row and gets no
  // badge at all, never a third invented label.
  it('badges a SOUNDBOX row SB, a COLLATERAL row COLL, and a legacy row with nothing', async () => {
    stubFetch(() =>
      jsonResponse({
        batch: BATCH_ROW,
        entries: [
          {
            asgnId: 'asgn_sb',
            merchantDisplayName: 'ALPHA TRADERS',
            merchantLegalName: 'ALPHA TRADERS PVT LTD',
            bankReferenceCode: '1568',
            bankDisplayName: 'GSC BANK',
            branchCode: '30',
            soundbox: true,
            standeeCount: 0,
            stickerCount: 0,
            poolStatus: 'BATCHED',
            dispatchState: null,
            shipToSuperseded: false,
            dispatchGroup: 'SOUNDBOX',
          },
          {
            asgnId: 'asgn_coll',
            merchantDisplayName: 'BETA TRADERS',
            merchantLegalName: 'BETA TRADERS PVT LTD',
            bankReferenceCode: '1568',
            bankDisplayName: 'GSC BANK',
            branchCode: '30',
            soundbox: false,
            standeeCount: 1,
            stickerCount: 0,
            poolStatus: 'BATCHED',
            dispatchState: null,
            shipToSuperseded: false,
            dispatchGroup: 'COLLATERAL',
          },
          {
            asgnId: 'asgn_legacy',
            merchantDisplayName: 'GAMMA TRADERS',
            merchantLegalName: 'GAMMA TRADERS PVT LTD',
            bankReferenceCode: '1568',
            bankDisplayName: 'GSC BANK',
            branchCode: '30',
            soundbox: true,
            standeeCount: 0,
            stickerCount: 0,
            poolStatus: 'BATCHED',
            dispatchState: null,
            shipToSuperseded: false,
            dispatchGroup: null,
          },
        ],
        artifacts: [],
      }),
    )
    renderBatchDetail('btch_abc')
    await screen.findByText('ALPHA TRADERS')
    expect(screen.getByText('SB')).toBeTruthy()
    expect(screen.getByLabelText('Soundbox dispatch')).toBeTruthy()
    expect(screen.getByText('COLL')).toBeTruthy()
    expect(screen.getByLabelText('Collateral dispatch')).toBeTruthy()
    // The legacy row's own CodeChip renders, but nothing badges it: only two
    // badge spans exist for three rows.
    expect(await screen.findByText('asgn_legacy')).toBeTruthy()
    expect(screen.queryAllByText(/^(SB|COLL)$/)).toHaveLength(2)
  })

  // The membership mirror (excelGroups) must be GROUP FIRST, exactly
  // services/fulfillment/src/package.ts excelLinesFor: a split row's own
  // dispatchGroup decides which Excel sheet it lands on even when its raw
  // soundbox/standeeCount/stickerCount flags would say otherwise under the
  // legacy combined-row heuristic. This single SOUNDBOX-group row has
  // soundbox=false and zero counts, which the OLD flag-only rule would have
  // routed to Collateral (the orphan rule: standeeCount 0, stickerCount 0,
  // NOT soundbox). If the mirror were left un-migrated, this test fails by
  // showing the wrong Excel button.
  it('the Excel buttons follow the row own dispatch group, not its raw product flags', async () => {
    stubFetch(() =>
      jsonResponse({
        batch: BATCH_ROW,
        entries: [
          {
            asgnId: 'asgn_sb_only',
            merchantDisplayName: 'DELTA TRADERS',
            merchantLegalName: 'DELTA TRADERS PVT LTD',
            bankReferenceCode: '1568',
            bankDisplayName: 'GSC BANK',
            branchCode: '30',
            soundbox: false,
            standeeCount: 0,
            stickerCount: 0,
            poolStatus: 'BATCHED',
            dispatchState: null,
            shipToSuperseded: false,
            dispatchGroup: 'SOUNDBOX',
          },
        ],
        artifacts: [],
      }),
    )
    renderBatchDetail('btch_abc')
    expect(await screen.findByRole('button', { name: /Soundbox Excel/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Collateral Excel/ })).toBeNull()
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

  it('batch detail states when it formed, not a word that never changes', async () => {
    stubFetch(() => jsonResponse({ batch: BATCH_ROW, entries: [], artifacts: [] }))
    renderBatchDetail('btch_abc')
    expect(await screen.findByText(/^Formed /)).toBeTruthy()
    expect(screen.queryByText(/BORN/)).toBeNull()
  })
})
