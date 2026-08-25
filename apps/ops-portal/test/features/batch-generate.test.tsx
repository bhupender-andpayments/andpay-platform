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

  // THE SUMMARY BAND (23 Aug 2026), replacing the old facts strip and its
  // "Shipped by vendor" pill. "Mapped" is a shipment existing for the leg
  // (courierStatus non-null), the faithful signal that the vendor's return
  // sheet came back for it, split by dispatch group. These are the numbers an
  // operator reads before deciding whether to chase the vendor.
  it('counts mapped legs from courierStatus, split by dispatch group', async () => {
    stub({
      batch: { ...BATCH, status: 'SENT_TO_PRINT_VENDOR' },
      entries: [
        entry({ asgnId: 'asgn_a', dispatchGroup: 'SOUNDBOX', courierStatus: 'IN_TRANSIT' }),
        entry({ asgnId: 'asgn_b', dispatchGroup: 'COLLATERAL', courierStatus: null }),
      ],
      artifacts: [artifact()],
      printLayout: 'ONE_PER_PAGE',
    })
    renderPage()

    const overall = (await screen.findByText('Mapped by vendor')).closest('div[class*="rounded-xl"]')!
    expect(overall.textContent).toContain('1/2')
    const soundbox = screen.getByText('Soundbox mapped').closest('div[class*="rounded-xl"]')!
    expect(soundbox.textContent).toContain('1/1')
    const collateral = screen.getByText('Collateral mapped').closest('div[class*="rounded-xl"]')!
    expect(collateral.textContent).toContain('0/1')
  })

  // THE REPLACEMENT STRIP (23 Aug 2026, ops-team ask): the damage-driven share
  // of the batch, stated once in amber under the summary band, only when there
  // is one to state.
  it('shows the replacement strip with the leg and kit breakdown when the batch carries replacements', async () => {
    stub({
      batch: BATCH,
      entries: [
        entry({ asgnId: 'asgn_a', dispatchGroup: 'SOUNDBOX', standeeCount: 0, stickerCount: 0 }),
        entry({ asgnId: 'asgn_b', dispatchGroup: 'SOUNDBOX', standeeCount: 0, stickerCount: 0, replacementOfAsgnId: 'asgn_old1' }),
        entry({ asgnId: 'asgn_c', dispatchGroup: 'COLLATERAL', soundbox: false, standeeCount: 1, stickerCount: 2, replacementOfAsgnId: 'asgn_old2' }),
      ],
      artifacts: [artifact()],
      printLayout: 'ONE_PER_PAGE',
    })
    renderPage()

    const label = await screen.findByText('Replacements in this batch')
    const strip = label.closest('div[class*="rounded-2xl"]')!
    expect(strip.textContent).toContain('2 dispatches')
    expect(strip.textContent).toContain('1 soundbox')
    expect(strip.textContent).toContain('1 collateral (1 standee, 2 stickers)')
  })

  it('shows NO replacement strip on a batch with none', async () => {
    stub({ batch: BATCH, entries: [entry()], artifacts: [artifact()], printLayout: 'ONE_PER_PAGE' })
    renderPage()
    await screen.findByText('Mapped by vendor')
    expect(screen.queryByText('Replacements in this batch')).toBeNull()
  })

  it('keeps Status, Trigger and Formed readable in the summary band', async () => {
    stub({ batch: BATCH, entries: [entry()], artifacts: [artifact()], printLayout: 'ONE_PER_PAGE' })
    renderPage()

    const status = (await screen.findByText('Status')).closest('div[class*="rounded-xl"]')!
    expect(status.textContent).toContain('MANUAL trigger')
    expect(status.textContent).toMatch(/formed/i)
  })

  // ONE SENTENCE OF NEXT-STEP GUIDANCE, keyed to the batch's state, so an
  // operator new to the flow is not left to infer the order from which
  // buttons happen to be enabled.
  it('tells a BATCHED batch to generate collateral and then send', async () => {
    stub({ batch: BATCH, entries: [entry()], artifacts: [artifact()], printLayout: 'ONE_PER_PAGE' })
    renderPage()
    expect(await screen.findByText(/then send this batch to the print vendor/i)).toBeTruthy()
  })

  it('tells a sent, partially mapped batch to upload the return sheet, with the count', async () => {
    stub({
      batch: { ...BATCH, status: 'SENT_TO_PRINT_VENDOR' },
      entries: [
        entry({ asgnId: 'asgn_a', dispatchGroup: 'SOUNDBOX', courierStatus: 'IN_TRANSIT' }),
        entry({ asgnId: 'asgn_b', dispatchGroup: 'COLLATERAL', courierStatus: null }),
      ],
      artifacts: [artifact()],
      printLayout: 'ONE_PER_PAGE',
    })
    renderPage()
    expect(await screen.findByText(/upload their return sheet/i)).toBeTruthy()
    expect(screen.getByText(/1 of 2 mapped so far/i)).toBeTruthy()
  })

  // MARK ALL DELIVERED IS ALWAYS CLICKABLE (23 Aug 2026, at the user's
  // direction): it used to render disabled with its reason in a title
  // attribute, so the operator had to hover a faded control to learn why. The
  // dialog now states the condition and only the confirm is gated, the same
  // shape Close batch already had.
  it('opens the deliver dialog even when not every dispatch has shipped, and gates only the confirm', async () => {
    stub({
      batch: { ...BATCH, status: 'SENT_TO_PRINT_VENDOR' },
      entries: [
        entry({ asgnId: 'asgn_a', dispatchState: 'DISPATCHED_BY_VENDOR' }),
        entry({ asgnId: 'asgn_b', dispatchState: 'SENT_TO_VENDOR' }),
      ],
      artifacts: [artifact()],
      printLayout: 'ONE_PER_PAGE',
    })
    renderPage()

    const open = await screen.findByRole('button', { name: /mark every dispatch in batch .* delivered/i })
    expect(open.hasAttribute('disabled')).toBe(false)
    await userEvent.click(open)

    const dialog = await screen.findByRole('dialog')
    // The condition, with its numbers, inside the dialog.
    expect(dialog.textContent).toContain('1/2')
    expect(within(dialog).getByText(/not every dispatch has reached the vendor yet/i)).toBeTruthy()
    expect(within(dialog).getByText(/return sheet/i)).toBeTruthy()
    // Only the confirm is gated.
    expect(within(dialog).getByRole('button', { name: /^mark all delivered$/i }).hasAttribute('disabled')).toBe(true)
  })

  it('allows the confirm once every dispatch has shipped', async () => {
    stub({
      batch: { ...BATCH, status: 'SENT_TO_PRINT_VENDOR' },
      entries: [entry({ asgnId: 'asgn_a', dispatchState: 'DISPATCHED_BY_VENDOR' })],
      artifacts: [artifact()],
      printLayout: 'ONE_PER_PAGE',
    })
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: /mark every dispatch in batch .* delivered/i }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: /^mark all delivered$/i }).hasAttribute('disabled')).toBe(false)
  })

  it('says a settled batch can be closed', async () => {
    stub({
      batch: { ...BATCH, status: 'SENT_TO_PRINT_VENDOR' },
      entries: [entry({ asgnId: 'asgn_a', dispatchGroup: 'SOUNDBOX', courierStatus: 'DELIVERED' })],
      artifacts: [artifact()],
      printLayout: 'ONE_PER_PAGE',
      settlement: { total: 1, delivered: 1, returned: 0, pending: 0, settled: true },
    })
    renderPage()
    expect(await screen.findByText(/this batch can be closed/i)).toBeTruthy()
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
