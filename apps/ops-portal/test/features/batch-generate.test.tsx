import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { BatchGeneratePage } from '../../src/features/fulfillment/generate/BatchGeneratePage.js'
import type { BatchArtifactRow, BatchEntryRow, BatchRow } from '../../src/api/endpoints.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// THE BATCH PAGE OPENS ON WHAT IS IN THE BATCH. It used to open on a single card
// with a pager: previous, next, and a jump-to-number box over a list that could
// not be searched, so answering "is this merchant in this batch, and what did
// they order" meant walking the run one card at a time.
//
// Now it is the common grid, one row per Dispatch ID with the ordered
// quantities, and a card is something asked for about one row.

const BATCH: BatchRow = {
  id: 'btch_50000000008008000000000009',
  triggerReason: 'MANUAL',
  unitCount: 2,
  printVndr: null,
  triggeredByActor: null,
  triggerNote: 'cut-off today',
  createdAt: '2026-08-12T09:00:00.000Z',
  updatedAt: '2026-08-12T09:00:00.000Z',
}

function entry(over: Partial<BatchEntryRow> = {}): BatchEntryRow {
  return {
    asgnId: 'asgn_50000000008008000000000001',
    merchantDisplayName: 'BRILLIANT PERFUME',
    merchantLegalName: 'BRILLIANT PERFUME LLP',
    bankReferenceCode: '3',
    bankDisplayName: 'GSCB',
    branchCode: '30',
    soundbox: true,
    standeeCount: 3,
    stickerCount: 4,
    poolStatus: 'BATCHED',
    dispatchState: 'SENT_TO_VENDOR',
    shipToSuperseded: false,
    dispatchGroup: null,
    ...over,
  }
}

function artifact(over: Partial<BatchArtifactRow> = {}): BatchArtifactRow {
  return {
    asgnId: 'asgn_50000000008008000000000001',
    artifactType: 'STANDEE_IMG',
    assetReference: 's3://x',
    supersededAt: null,
    labelQr: 'upi://pay?pa=brilliant@hdfcbank&pn=BRILLIANT%20PERFUME',
    labelDisplayName: 'BRILLIANT PERFUME',
    ...over,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// The existing suites below only ever assert on the batch detail body and
// never on the rail, so the journey call is answered with a 500 here: the
// page's own failure handling turns that into "no rail", which is inert for
// every assertion those suites make.
function stub(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('/ops/reports/batch-journey/') ? jsonResponse({ message: 'boom' }, 500) : jsonResponse(body),
    ),
  )
}

// The journey-aware suite below routes by URL: batch detail on one path,
// batch-journey on the other, so the rail sees real BatchJourneyView counts
// and the two fetches cannot be confused with one another.
function stubWithJourney(detailBody: unknown, journeyStatusOrBody: number | unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/ops/reports/batch-journey/')) {
        return typeof journeyStatusOrBody === 'number'
          ? jsonResponse({ message: 'boom' }, journeyStatusOrBody)
          : jsonResponse(journeyStatusOrBody)
      }
      return jsonResponse(detailBody)
    }),
  )
}

function renderPage() {
  render(
    <MemoryRouter
      initialEntries={['/batches/btch_50000000008008000000000009']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AuthProvider>
        <Routes>
          <Route path="/batches/:btchId" element={<BatchGeneratePage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('The batch page lists its dispatches', () => {
  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  it('shows one row per Dispatch ID with the quantities that were ordered', async () => {
    stub({ batch: BATCH, entries: [entry()], artifacts: [artifact()], printLayout: 'ONE_PER_PAGE' })
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    // The three ordered quantities are each their own column, so they can be
    // scanned and sorted rather than read out of one sentence.
    for (const header of ['Dispatch ID', 'Soundbox', 'Standee', 'Sticker']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeTruthy()
    }
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()
  })

  it('lists a dispatch whose card has not composed, with its preview disabled rather than missing', async () => {
    stub({ batch: BATCH, entries: [entry()], artifacts: [], printLayout: 'ONE_PER_PAGE' })
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    const view = await screen.findByRole('button', { name: /view qr card for BRILLIANT PERFUME/i })
    expect((view as HTMLButtonElement).disabled).toBe(true)
  })

  // A batch opened the instant it formed has entries and no artifacts. That is
  // not a broken page: the dispatch list and the vendor Excel both work, and
  // only the print run has nothing to do yet.
  it('keeps the dispatch list and the Excel when nothing has composed yet', async () => {
    stub({ batch: BATCH, entries: [entry()], artifacts: [], printLayout: 'ONE_PER_PAGE' })
    renderPage()

    expect(await screen.findByText(/no cards have been composed/i)).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Dispatch ID' })).toBeTruthy()
    expect(screen.getByText(/dispatch excel for the print vendor/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /check again/i })).toBeTruthy()
  })

  it('has no pager, because the grid replaced it', async () => {
    stub({ batch: BATCH, entries: [entry()], artifacts: [artifact()], printLayout: 'ONE_PER_PAGE' })
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^previous$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^next$/i })).toBeNull()
    expect(screen.queryByPlaceholderText(/jump to a card/i)).toBeNull()
  })

  it('does not repeat the dispatch rows as a second, truncated table under the Excel', async () => {
    stub({ batch: BATCH, entries: [entry()], artifacts: [artifact()], printLayout: 'ONE_PER_PAGE' })
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(screen.queryByText(/\(vendor fills\)/i)).toBeNull()
    expect(screen.queryByText(/showing the first 10/i)).toBeNull()
  })
})

// Task 6: the aggregate lifecycle rail, fed by getBatchJourney and rendered
// under the hero row. It is an enhancement over the dispatch list, never a
// gate on it: a journey fetch failure must leave the rest of the page fully
// working.
describe('The batch page shows the aggregate lifecycle rail', () => {
  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  const JOURNEY = {
    batchId: BATCH.id,
    counts: { total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 1, delivered: 0, activated: 0 },
    activation: { notRequested: null, requested: null, activated: 0 },
  }

  it('renders every rung label and the Dispatched rung as a fraction of the total', async () => {
    stubWithJourney({ batch: BATCH, entries: [entry()], artifacts: [artifact()], printLayout: 'ONE_PER_PAGE' }, JOURNEY)
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    // 'Sent to vendor' renders twice here: once as the rail rung label, once
    // as the grid row's own status pill (the row's dispatchState happens to
    // be SENT_TO_VENDOR), so it is checked with getAllByText rather than the
    // single-match getByText the other labels use.
    for (const label of ['Batched', 'Dispatched by vendor', 'Delivered', 'Activated']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.getAllByText('Sent to vendor').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('1/4')).toBeTruthy()
  })

  it('keeps the rest of the page fully working when the journey fetch fails', async () => {
    stubWithJourney({ batch: BATCH, entries: [entry()], artifacts: [artifact()], printLayout: 'ONE_PER_PAGE' }, 500)
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Dispatch ID' })).toBeTruthy()
    // No rail, since the journey never arrived, but nothing else broke.
    expect(screen.queryByText('Batched')).toBeNull()
  })

  it('upgrades the dispatch grid State column to a status pill', async () => {
    stubWithJourney({ batch: BATCH, entries: [entry({ dispatchState: 'SENT_TO_VENDOR' })], artifacts: [artifact()], printLayout: 'ONE_PER_PAGE' }, JOURNEY)
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    // "Sent to vendor" now renders twice: once as the rail rung label, once
    // as the grid's status pill for this row's dispatchState.
    const hits = screen.getAllByText('Sent to vendor')
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits.some((el) => el.className.includes('pill'))).toBe(true)
  })
})

describe('The batch page previews one dispatch QR on demand', () => {
  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  it('opens the card for the row that asked, naming that merchant and its payload', async () => {
    stub({ batch: BATCH, entries: [entry()], artifacts: [artifact()], printLayout: 'ONE_PER_PAGE' })
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: /view qr card for BRILLIANT PERFUME/i }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('BRILLIANT PERFUME')
    // The UPI ID comes out of the QR's own pa= parameter, so there is no second
    // source for it, and the whole payload is readable for checking against the
    // bank's file.
    expect(dialog.textContent).toContain('brilliant@hdfcbank')
    expect(dialog.textContent).toContain('upi://pay?pa=')
  })

  it('offers the card-type switch only when the dispatch really has both cards', async () => {
    stub({
      batch: BATCH,
      entries: [entry({ soundbox: false, standeeCount: 2, stickerCount: 0 })],
      artifacts: [artifact()],
      printLayout: 'ONE_PER_PAGE',
    })
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: /view qr card/i }))
    await screen.findByRole('dialog')
    expect(screen.queryByRole('tablist', { name: /card type/i })).toBeNull()
  })
})

// Task 8: the Next step card, fed by the same journey read the rail (Task 6)
// already renders. The controller ruling (2026-08-18, spec batch-first-ops-ux
// task 4) collapses the brief's original six-stage vocabulary into four
// (PRINTING, SHIPPING, ACTIVATION, COMPLETE), so the brief's own
// READY_FOR_CWD test case is read here as the ACTIVATION stage.
describe('The batch page offers a Next step card driven by the batch stage', () => {
  interface Call {
    url: string
    init: RequestInit
  }

  function makeFakeJwt(claims: Record<string, unknown>): string {
    const json = JSON.stringify(claims)
    const base64 = btoa(json)
    const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `header.${base64url}.signature`
  }

  // One full BatchJourneyView shape per call, with only the fields a given
  // stage cares about overridden: a partial object here would silently pass
  // TypeScript (nothing in this file types the fetch stub's body against the
  // real interface) while leaving the component to read `undefined` off a
  // field a different stage happened not to touch.
  function journeyView(
    counts: { total: number; deliverableAndActivatable: number; sentToVendor: number; dispatched: number; delivered: number; activated: number },
    awaitingActivation: { dispatchId: string; merchantDisplay: string; awb: string | null; deliveryDate: string | null; deviceCount?: number }[] = [],
  ) {
    return {
      batchId: BATCH.id,
      counts,
      courier: { pickedUp: 0, inTransit: 0, outForDelivery: 0, delivered: 0, exception: 0 },
      activation: { awaiting: 0, activated: 0, failed: 0, simActivated: null },
      sentToVendorAt: null,
      awaitingActivation,
      watermark: { asOf: null, perTopic: {} },
    }
  }

  function stubRoutes(
    detailBody: unknown,
    journeyBody: unknown,
    extra?: (url: string, init: RequestInit) => Response | undefined,
  ): Call[] {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init })
        const overridden = extra?.(url, init)
        if (overridden !== undefined) return overridden
        if (url.includes('/ops/reports/batch-journey/')) return jsonResponse(journeyBody)
        return jsonResponse(detailBody)
      }),
    )
    return calls
  }

  const DETAIL = { batch: BATCH, entries: [entry()], artifacts: [artifact()], printLayout: 'ONE_PER_PAGE' }

  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  it('at PRINTING (not everything dispatched) offers the return sheet dropzone', async () => {
    stubRoutes(DETAIL, journeyView({ total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 1, delivered: 0, activated: 0 }))
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(await screen.findByText('Next step')).toBeTruthy()
    expect(document.getElementById('embedded-upload-return')).toBeTruthy()
    expect(document.getElementById('embedded-upload-courier-status')).toBeNull()
    expect(document.getElementById('embedded-upload-activation')).toBeNull()
  })

  it('at SHIPPING (dispatched but not all delivered) offers the courier status dropzone', async () => {
    stubRoutes(DETAIL, journeyView({ total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 4, delivered: 1, activated: 0 }))
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(await screen.findByText('Next step')).toBeTruthy()
    expect(document.getElementById('embedded-upload-courier-status')).toBeTruthy()
    expect(document.getElementById('embedded-upload-return')).toBeNull()
  })

  // D-16 controller ruling: activation has no delivery gate. A batch still
  // SHIPPING (not everything delivered) can already have dispatches sitting
  // in awaitingActivation, and the CWD block must render right alongside the
  // courier dropzone rather than waiting for the last shipment to land.
  it('at SHIPPING with a partial delivery, renders both the courier dropzone and the CWD block', async () => {
    const AWAITING = [
      { dispatchId: 'asgn_50000000008008000000000001', merchantDisplay: 'BRILLIANT PERFUME', awb: null, deliveryDate: null, deviceCount: 2 },
    ]
    stubRoutes(
      DETAIL,
      journeyView({ total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 4, delivered: 1, activated: 0 }, AWAITING),
    )
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(await screen.findByText('Next step')).toBeTruthy()
    expect(document.getElementById('embedded-upload-courier-status')).toBeTruthy()
    expect(screen.getByRole('button', { name: /download activation sheet/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^mark sent to cwd$/i })).toBeTruthy()
    // The activation-file dropzone stays ACTIVATION-only: a shipping batch's
    // devices are not even confirmed activatable by CWD yet.
    expect(document.getElementById('embedded-upload-activation')).toBeNull()
  })

  // Ruling: the CWD block keys on device-paired rows, not on the stage. A row
  // still sitting at zero devices (not yet paired at return-sheet ingest) has
  // nothing CWD can act on, so it never shows up in the list or the count,
  // even at PRINTING where the return-sheet dropzone is also on screen.
  it('at PRINTING, the CWD block stays hidden when awaitingActivation carries no device-paired row', async () => {
    const AWAITING = [
      { dispatchId: 'asgn_50000000008008000000000001', merchantDisplay: 'BRILLIANT PERFUME', awb: null, deliveryDate: null, deviceCount: 0 },
    ]
    stubRoutes(
      DETAIL,
      journeyView({ total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 1, delivered: 0, activated: 0 }, AWAITING),
    )
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(await screen.findByText('Next step')).toBeTruthy()
    expect(document.getElementById('embedded-upload-return')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /download activation sheet/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /mark sent to cwd/i })).toBeNull()
  })

  // The reworked CWD section: still at PRINTING (only 1 of 4 dispatched by
  // the vendor so far) but one dispatch already came back device-paired on
  // the return sheet. The sheet is already valid for that row, so the
  // section renders right alongside the return-sheet dropzone rather than
  // waiting for the batch to leave PRINTING, and the batch-scoped activation
  // list underneath shows only the device-paired row, never the one still at
  // zero devices.
  it('at PRINTING with one device-paired row and one not yet paired, the CWD section lists only the paired row', async () => {
    const AWAITING = [
      { dispatchId: 'asgn_50000000008008000000000001', merchantDisplay: 'BRILLIANT PERFUME', awb: 'AWB1', deliveryDate: null, deviceCount: 2 },
      { dispatchId: 'asgn_50000000008008000000000099', merchantDisplay: 'NOT YET PAIRED', awb: null, deliveryDate: null, deviceCount: 0 },
    ]
    const calls = stubRoutes(
      DETAIL,
      journeyView({ total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 1, delivered: 0, activated: 0 }, AWAITING),
      (url) => {
        if (url.includes('/ops/assignments/request-activation')) {
          return jsonResponse({ deduped: false, recorded: ['asgn_50000000008008000000000001'], unknown: [] })
        }
        return undefined
      },
    )
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(document.getElementById('embedded-upload-return')).toBeTruthy()
    expect(screen.getByRole('button', { name: /download activation sheet/i })).toBeTruthy()
    // The un-paired dispatch never appears anywhere on the page.
    expect(screen.queryByText('NOT YET PAIRED')).toBeNull()
    // Exactly one row in the batch activation list: the per-row "Mark
    // activated" button count is the simplest proof, since it excludes the
    // bulk "Mark N activated" button by its distinct accessible name.
    expect(screen.getAllByRole('button', { name: /^mark activated$/i }).length).toBe(1)

    await userEvent.click(screen.getByRole('button', { name: /^mark sent to cwd$/i }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/1 dispatch\b/i)

    await userEvent.click(within(dialog).getByRole('button', { name: /mark sent to cwd/i }))

    const write = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/request-activation'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(JSON.parse(write.init.body as string).dispatchIds).toEqual(['asgn_50000000008008000000000001'])
  })

  it('when every awaitingActivation row has zero devices, the CWD section is entirely absent', async () => {
    const AWAITING = [
      { dispatchId: 'asgn_50000000008008000000000001', merchantDisplay: 'BRILLIANT PERFUME', awb: null, deliveryDate: null, deviceCount: 0 },
      { dispatchId: 'asgn_50000000008008000000000002', merchantDisplay: 'SECOND MERCHANT', awb: null, deliveryDate: null, deviceCount: 0 },
    ]
    stubRoutes(
      DETAIL,
      journeyView({ total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 4, delivered: 4, activated: 0 }, AWAITING),
    )
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(await screen.findByText('Next step')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /download activation sheet/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /mark sent to cwd/i })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /select/i })).toBeNull()
  })

  // The batch-scoped activation list's bulk flow: tick a row, confirm, and
  // the write posts exactly the ticked dispatch id with a fresh
  // Idempotency-Key to the bulk activate route, then the page's own journey
  // and detail reads run again so the rail, chip and list catch up.
  it('bulk-selecting one row in the CWD list and confirming posts that dispatchId to activate-bulk and refetches the batch', async () => {
    const AWAITING = [
      { dispatchId: 'asgn_50000000008008000000000001', merchantDisplay: 'BRILLIANT PERFUME', awb: null, deliveryDate: null, deviceCount: 1 },
      { dispatchId: 'asgn_50000000008008000000000002', merchantDisplay: 'SECOND MERCHANT', awb: null, deliveryDate: null, deviceCount: 1 },
    ]
    const calls = stubRoutes(
      DETAIL,
      journeyView({ total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 4, delivered: 4, activated: 0 }, AWAITING),
      (url) => {
        if (url.includes('/ops/assignments/activate-bulk')) {
          return jsonResponse({ results: [{ dispatchId: 'asgn_50000000008008000000000001', activated: true, reason: null }] })
        }
        return undefined
      },
    )
    renderPage()

    // 'BRILLIANT PERFUME' renders twice here: once as the dispatch grid's own
    // row (the fixture entry shares that merchant name), once as the CWD
    // list's row for the same dispatch id, so it is awaited with
    // findAllByText rather than the single-match findByText the other tests
    // use.
    await screen.findAllByText('BRILLIANT PERFUME')
    expect(await screen.findByText('SECOND MERCHANT')).toBeTruthy()

    const journeyCallsBefore = calls.filter((c) => c.url.includes('/ops/reports/batch-journey/')).length
    const detailCallsBefore = calls.length - journeyCallsBefore

    await userEvent.click(screen.getByRole('checkbox', { name: /select asgn_50000000008008000000000001/i }))

    const trigger = screen.getByRole('button', { name: /^mark 1 activated$/i })
    await userEvent.click(trigger)
    // First click only opens the dialog; nothing has been written yet.
    expect(calls.some((c) => c.url.includes('/activate-bulk'))).toBe(false)

    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^mark 1 activated$/i }))

    const write = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/activate-bulk'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(write.init.method).toBe('POST')
    expect(JSON.parse(write.init.body as string).dispatchIds).toEqual(['asgn_50000000008008000000000001'])
    const headers = write.init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBeTruthy()

    // The per-row outcome renders in the CWD list's own table. Scoped to that
    // table because the lifecycle rail above also has an "Activated" rung
    // label once the batch has anything deliverable and activatable.
    const cwdTable = screen.getByText('Last result').closest('table')
    if (cwdTable === null) throw new Error('CWD list table not found')
    expect(await within(cwdTable).findByText(/^activated$/i)).toBeTruthy()
    await vi.waitFor(() => {
      const journeyCallsAfter = calls.filter((c) => c.url.includes('/ops/reports/batch-journey/')).length
      expect(journeyCallsAfter).toBeGreaterThan(journeyCallsBefore)
      const detailCallsAfter = calls.length - journeyCallsAfter
      expect(detailCallsAfter).toBeGreaterThan(detailCallsBefore)
    })
  })

  // Regression: `selected` is state that outlives a render, and a row can
  // leave the live CWD list out from under it (here, the OTHER row's own
  // per-row activation triggers the journey refetch that drops it). Before
  // the `selectedLive` reconciliation, the bulk button kept counting the now
  // gone row and the bulk POST would still have carried its stale dispatchId
  // alongside the one still on screen.
  it('drops a selection whose row left the live CWD list before the next bulk POST, so only the remaining dispatchId is sent', async () => {
    const FIRST_ID = 'asgn_50000000008008000000000001'
    const SECOND_ID = 'asgn_50000000008008000000000002'
    const SECOND_ROW = { dispatchId: SECOND_ID, merchantDisplay: 'SECOND MERCHANT', awb: null, deliveryDate: null, deviceCount: 1 }
    const AWAITING = [
      { dispatchId: FIRST_ID, merchantDisplay: 'BRILLIANT PERFUME', awb: null, deliveryDate: null, deviceCount: 1 },
      SECOND_ROW,
    ]
    const REMAINING = [SECOND_ROW]
    let journeyCallCount = 0
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init })
        if (url.includes('/ops/assignments/activate-bulk')) {
          return jsonResponse({ results: [{ dispatchId: SECOND_ID, activated: true, reason: null }] })
        }
        if (url.includes('/ops/assignments/activate')) {
          return jsonResponse({ activated: true })
        }
        if (url.includes('/ops/reports/batch-journey/')) {
          journeyCallCount += 1
          // The first read hands back both device-paired rows; every read
          // after the per-row activation hands back only the survivor, the
          // same way a real refetch would once the CWD confirms one device.
          const awaiting = journeyCallCount === 1 ? AWAITING : REMAINING
          return jsonResponse(
            journeyView(
              { total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 4, delivered: 4, activated: 0 },
              awaiting,
            ),
          )
        }
        return jsonResponse(DETAIL)
      }),
    )
    renderPage()

    await screen.findAllByText('BRILLIANT PERFUME')
    await screen.findByText('SECOND MERCHANT')

    // Select both device-paired rows.
    await userEvent.click(screen.getByRole('checkbox', { name: new RegExp(`select ${FIRST_ID}`, 'i') }))
    await userEvent.click(screen.getByRole('checkbox', { name: new RegExp(`select ${SECOND_ID}`, 'i') }))
    expect(screen.getByRole('button', { name: /^mark 2 activated$/i })).toBeTruthy()

    // Activate the first row alone through its own per-row action.
    const [firstRowButton] = screen.getAllByRole('button', { name: /^mark activated$/i })
    if (firstRowButton === undefined) throw new Error('expected a per-row Mark activated button')
    await userEvent.click(firstRowButton)
    const rowDialog = await screen.findByRole('dialog')
    await userEvent.click(within(rowDialog).getByRole('button', { name: /^mark activated$/i }))

    // The refetch this triggers drops the first row from the live list. Once
    // that lands, the still-selected second row is all `selectedLive` counts.
    const bulkTrigger = await screen.findByRole('button', { name: /^mark 1 activated$/i })
    await userEvent.click(bulkTrigger)
    // First click only opens the confirmation; nothing posted yet.
    expect(calls.some((c) => c.url.includes('/activate-bulk'))).toBe(false)

    const bulkDialog = await screen.findByRole('dialog')
    await userEvent.click(within(bulkDialog).getByRole('button', { name: /^mark 1 activated$/i }))

    const write = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/activate-bulk'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(JSON.parse(write.init.body as string).dispatchIds).toEqual([SECOND_ID])
  })

  it('a per-row Mark activated posts { dispatchId } to /ops/assignments/activate', async () => {
    const AWAITING = [
      { dispatchId: 'asgn_50000000008008000000000001', merchantDisplay: 'BRILLIANT PERFUME', awb: null, deliveryDate: null, deviceCount: 1 },
    ]
    const calls = stubRoutes(
      DETAIL,
      journeyView({ total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 4, delivered: 4, activated: 0 }, AWAITING),
      (url) => {
        if (url.includes('/ops/assignments/activate') && !url.includes('activate-bulk')) {
          return jsonResponse({ activated: true })
        }
        return undefined
      },
    )
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^mark activated$/i }))

    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^mark activated$/i }))

    const write = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/ops/assignments/activate') && !c.url.includes('activate-bulk'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(write.init.method).toBe('POST')
    expect(JSON.parse(write.init.body as string)).toEqual({ dispatchId: 'asgn_50000000008008000000000001' })
  })

  // The brief's READY_FOR_CWD case, read as ACTIVATION per the controller
  // ruling: everything delivered, something still activatable and not yet
  // activated. Both the CWD send actions and the activation dropzone render
  // together (the ruling's "replaces READY_FOR_CWD and AWAITING_ACTIVATION").
  it('at ACTIVATION offers the CWD download, a confirmed Mark sent to CWD posting dispatchIds with an Idempotency-Key, and the activation dropzone', async () => {
    const AWAITING = [
      { dispatchId: 'asgn_50000000008008000000000001', merchantDisplay: 'BRILLIANT PERFUME', awb: null, deliveryDate: null, deviceCount: 1 },
      { dispatchId: 'asgn_50000000008008000000000002', merchantDisplay: 'SECOND MERCHANT', awb: null, deliveryDate: null, deviceCount: 1 },
    ]
    const calls = stubRoutes(
      DETAIL,
      journeyView({ total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 4, delivered: 4, activated: 0 }, AWAITING),
      (url) => {
        if (url.includes('/ops/reports/activation/batch/')) {
          return new Response('xlsx-bytes', {
            status: 200,
            headers: { 'content-type': 'application/vnd.ms-excel', 'content-disposition': 'attachment; filename="activation-btch.xlsx"' },
          })
        }
        if (url.includes('/ops/assignments/request-activation')) {
          return jsonResponse({ deduped: false, recorded: AWAITING.map((a) => a.dispatchId), unknown: [] })
        }
        return undefined
      },
    )
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:mock-url', writable: true, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true, configurable: true })

    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(await screen.findByText('Next step')).toBeTruthy()
    expect(document.getElementById('embedded-upload-activation')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /download activation sheet/i }))
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/reports/activation/batch/'))).toBe(true)
    })

    await userEvent.click(screen.getByRole('button', { name: /^mark sent to cwd$/i }))
    // The first click only asks; nothing has been written yet.
    expect(calls.some((c) => c.url.includes('/request-activation'))).toBe(false)

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/2 dispatches/i)

    await userEvent.click(within(dialog).getByRole('button', { name: /mark sent to cwd/i }))

    const write = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/request-activation'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(write.init.method).toBe('POST')
    expect(JSON.parse(write.init.body as string).dispatchIds).toEqual(AWAITING.map((a) => a.dispatchId))
    const headers = write.init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBeTruthy()
  })

  it('at COMPLETE renders a quiet done note and no actions, even with a device-paired row still listed', async () => {
    stubRoutes(
      DETAIL,
      journeyView({ total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 4, delivered: 4, activated: 2 }, [
        { dispatchId: 'asgn_50000000008008000000000001', merchantDisplay: 'BRILLIANT PERFUME', awb: null, deliveryDate: null, deviceCount: 1 },
      ]),
    )
    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    expect(await screen.findByText('Next step')).toBeTruthy()
    expect(screen.getByText(/nothing left to do/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /download activation sheet/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /mark sent to cwd/i })).toBeNull()
    expect(document.getElementById('embedded-upload-return')).toBeNull()
    expect(document.getElementById('embedded-upload-courier-status')).toBeNull()
    expect(document.getElementById('embedded-upload-activation')).toBeNull()
  })

  it('renders no action-bearing content for customer_support', async () => {
    clearAccessToken()
    const fakeToken = makeFakeJwt({ sub: 'ops-1', psr: 'role:customer_support' })
    stubRoutes(
      DETAIL,
      journeyView({ total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 4, delivered: 4, activated: 0 }, [
        { dispatchId: 'asgn_50000000008008000000000001', merchantDisplay: 'BRILLIANT PERFUME', awb: null, deliveryDate: null, deviceCount: 1 },
      ]),
      (url) => (url.includes('/session/rehydrate') ? jsonResponse({ accessToken: fakeToken }) : undefined),
    )

    renderPage()

    expect(await screen.findByText('BRILLIANT PERFUME')).toBeTruthy()
    await vi.waitFor(() => {
      expect(screen.queryByText('Next step')).toBeNull()
    })
    expect(document.getElementById('embedded-upload-activation')).toBeNull()
    expect(screen.queryByRole('button', { name: /download activation sheet/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /mark sent to cwd/i })).toBeNull()
  })
})
