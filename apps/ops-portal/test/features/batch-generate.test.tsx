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
  status: 'BATCHED',
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

function stub(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })),
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
    // scanned and sorted rather than read out of one sentence. Bank and Branch
    // are two columns as of 18 Aug 2026, for the same reason: they used to be
    // one "3 / 30" cell that could be sorted by neither half.
    for (const header of ['Dispatch ID', 'Bank', 'Branch', 'Soundbox', 'Standee', 'Sticker']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeTruthy()
    }
    const row = screen.getByText('BRILLIANT PERFUME').closest('tr')!
    // The fixture's bank code and standee count are BOTH '3', so this asserts
    // per cell rather than by page-wide text: a single getByText('3') would be
    // ambiguous and would pass for the wrong reason.
    const cells = within(row).getAllByRole('cell')
    const text = cells.map((c) => c.textContent)
    expect(text).toContain('3') // bank code, and separately the standee count
    expect(text).toContain('30') // branch, no longer glued to the bank
    expect(text).toContain('4') // stickers
    // The combined form is gone.
    expect(within(row).queryByText('3 / 30')).toBeNull()
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

  // Ruled 21 Aug 2026: wherever bank data appears it points at master bank
  // data. The proof therefore shows the STORED artifact (composed server-side
  // with the aggregator's logo from the asset store), not a client-drawn
  // lookalike: opening the dialog must fetch the dispatch's own artifact.
  it('the proof fetches the stored artifact for that dispatch, not a client-drawn card', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url.includes('/artifacts/')) {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/pdf' } })
        }
        return new Response(
          JSON.stringify({ batch: BATCH, entries: [entry()], artifacts: [artifact()], printLayout: 'ONE_PER_PAGE' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: /view qr card for BRILLIANT PERFUME/i }))
    await screen.findByRole('dialog')

    // The fixture dispatch has a STANDEE_IMG artifact, so the proof asks for
    // exactly that stored card, keyed by batch and dispatch.
    const artifactCalls = calls.filter((u) => u.includes('/artifacts/'))
    expect(artifactCalls.length).toBeGreaterThan(0)
    expect(
      artifactCalls[0]!.endsWith(
        '/ops/batches/btch_50000000008008000000000009/artifacts/asgn_50000000008008000000000001/STANDEE_IMG',
      ),
    ).toBe(true)
  })

  // 19 Aug 2026: HOW FAR THROUGH THE VENDOR IS.
  //
  // A batch reads "Sent to print vendor" from the moment it is sent until every
  // dispatch settles, which is most of its life and says nothing about progress.
  // The vendor ships what is ready and sends the rest later, and nowhere else
  // surfaces that: the Activation worklist DROPS an unpaired dispatch (no device,
  // nothing to activate), so activating 4 of 5 gives no signal that a 5th is
  // still awaited. Counted off dispatch_state, the same column the State cells
  // render, so the pill and the rows cannot disagree.
  it('shows how many dispatches the vendor has shipped, once the batch has been sent', async () => {
    stub({
      batch: { ...BATCH, status: 'SENT_TO_PRINT_VENDOR' },
      entries: [
        entry({ asgnId: 'asgn_a', dispatchState: 'DISPATCHED_BY_VENDOR' }),
        entry({ asgnId: 'asgn_b', dispatchState: 'DISPATCHED_BY_VENDOR' }),
        entry({ asgnId: 'asgn_c', dispatchState: 'SENT_TO_VENDOR' }),
      ],
      artifacts: [artifact()],
      printLayout: 'ONE_PER_PAGE',
    })
    renderPage()

    // The count is split across <span class="num"> elements so the digits get the
    // tabular font, so the assertion reads the whole cell rather than one node.
    const label = await screen.findByText('Shipped by vendor')
    const cell = label.parentElement!
    expect(cell.textContent?.replace(/\s+/g, ' ')).toContain('2 of 3 dispatched')
  })

  it('says nothing about vendor progress before the batch has been sent', async () => {
    // 0 of N on a batch nobody has sent yet reads as a fault rather than a
    // not-yet, so the pill is absent until there is progress to report.
    stub({ batch: BATCH, entries: [entry()], artifacts: [artifact()], printLayout: 'ONE_PER_PAGE' })
    renderPage()

    await screen.findByText('BRILLIANT PERFUME')
    expect(screen.queryByText('Shipped by vendor')).toBeNull()
  })
})

describe('The print run is assembled server-side from the stored artifacts', () => {
  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
    // jsdom has no URL.createObjectURL; the page only needs a string back.
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    }))
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  const DETAIL = { batch: BATCH, entries: [entry()], artifacts: [artifact()], printLayout: 'ONE_PER_PAGE' }

  function stubWithCollateral(calls: string[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url.includes('/collateral/')) {
          // Not a parseable PDF on purpose: the page must still produce the
          // preview/download row, just without a page count.
          return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/pdf' } })
        }
        return new Response(JSON.stringify(DETAIL), { status: 200, headers: { 'content-type': 'application/json' } })
      }),
    )
  }

  // Ruled 21 Aug 2026: the print run renders per-aggregator logos from S3,
  // same as the server. That means the run is NOT drawn client-side off the
  // static GSCB plate any more; it is the server's dispatch package
  // (assembleGroupPdf over composed_artifact), fetched per delivery group.
  it('Render fetches the server group PDFs instead of drawing cards client-side', async () => {
    const calls: string[] = []
    stubWithCollateral(calls)
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: /render 2 card\(s\)/i }))

    // The fixture wants a standee AND a soundbox, so both delivery groups are
    // fetched, on the server's own group vocabulary.
    expect(await screen.findByText('Standee / sticker PDF')).toBeTruthy()
    expect(screen.getByText('Soundbox PDF')).toBeTruthy()
    const collateralCalls = calls.filter((u) => u.includes('/collateral/'))
    expect(collateralCalls.some((u) => u.endsWith('/collateral/COLLATERAL'))).toBe(true)
    expect(collateralCalls.some((u) => u.endsWith('/collateral/SOUNDBOX'))).toBe(true)
  })

  it('the paper layout is stated from the batch, not picked client-side', async () => {
    stubWithCollateral([])
    renderPage()

    // W-6: the layout belongs to the bound print vendor's press. The old
    // client-side picker is gone; the batch's own printLayout is stated.
    expect(await screen.findByText(/one card per page/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /6 per sheet/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /one card per page/i })).toBeNull()
  })
})

describe('The batch page previews one dispatch QR on demand (card-type switch)', () => {
  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
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
