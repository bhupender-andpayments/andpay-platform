import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { DispatchDetailPage } from '../../src/features/dispatches/DispatchDetailPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The per-dispatch detail page: ONE horizontal rail over the BRD delivery
// ladder, and NO activation anywhere on it. Parcels deliver, devices activate,
// and the Activation section owns that axis (2026-08-15 ruling, briefly
// reversed on 16 Aug and reinstated the same day after the UAT walkthrough).
// The response shape below mirrors the edge's dispatchDetail route
// (apps/ops-edge/src/reports.controller.ts); nothing is invented here. It
// deliberately keeps activationStatus and a populated activationTrail so the
// tests prove the page ignores them rather than merely lacking the data.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const ASGN = 'asgn_01kzwrejswe5hvfjazjgfh01q6'

// The shape the old ladder could not hold: the CWD confirmed at 12:00 while the
// parcel was still in transit at 15:00.
const DETAIL = {
  dispatchId: ASGN,
  dispatchGroup: 'SOUNDBOX',
  bankCode: 'HDFC',
  bankDisplay: 'HDFC Bank',
  merchantDisplay: 'Flow Alpha Store',
  deviceIds: ['SB-1'],
  batchId: 'btch_1',
  awb: 'AWB-D1',
  shptId: 'shpt_1',
  dispatchDate: '2026-08-12T08:00:00.000Z',
  courierStatus: 'IN_TRANSIT',
  deliveryDate: null,
  activationStatus: 'ACTIVATED',
  activationDate: '2026-08-12T12:00:00.000Z',
  deliveryTrail: [
    { status: 'PICKED_UP', courierTimestamp: '2026-08-12T09:00:00.000Z', statusSource: 'courier-file', sourceRef: 'vndr_1|file_7', receivedAt: '2026-08-12T09:05:00.000Z', overrideReason: null },
    { status: 'IN_TRANSIT', courierTimestamp: '2026-08-12T15:00:00.000Z', statusSource: 'courier-file', sourceRef: 'vndr_1|file_8', receivedAt: '2026-08-12T15:04:00.000Z', overrideReason: null },
  ],
  activationTrail: [
    { status: 'REQUEST_SENT_TO_CWD', occurredAt: '2026-08-12T10:00:00.000Z', statusSource: 'ops:request-activation', actorId: null, recordedAt: '2026-08-12T10:00:30.000Z' },
    { status: 'ACTIVATED', occurredAt: '2026-08-12T12:00:00.000Z', statusSource: 'ops:mark-activated', actorId: null, recordedAt: '2026-08-12T12:00:20.000Z' },
  ],
  watermark: { asOf: '2026-08-12T16:00:00.000Z', perTopic: {} },
}

function stub(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body, status)))
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/dispatches/${ASGN}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/dispatches/:asgnId" element={<DispatchDetailPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('DispatchDetailPage (D-16, T4.5)', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  // REVISED 16 Aug 2026, second pass. The morning's finding A3/A4 put activation
  // back on this page as its own card; the UAT walkthrough that afternoon took
  // it off again for good. So this test is once more the strong claim it
  // originally was: a dispatch delivers, it does not activate, and NOTHING on
  // this page speaks to the activation axis. Not a rung, not a card, not a
  // button. The Activation section owns that axis alone.
  it('renders the delivery ladder as one rail, and shows no activation surface at all', async () => {
    stub(DETAIL)
    renderPage()

    expect(await screen.findByText('Dispatch lifecycle')).toBeTruthy()
    for (const label of [
      'Received',
      'Pending batch',
      'QR generated',
      'Sent to print vendor',
      'Dispatched by vendor',
      'Delivered',
    ]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    // In transit is the current rung AND the header pill, so it appears twice.
    expect(screen.getAllByText(/in transit/i).length).toBeGreaterThan(0)

    // No activation card, no heading, neither write. DETAIL is ACTIVATED and
    // carries a full activationTrail, so this fixture would light up every one
    // of these if any activation surface survived.
    expect(screen.queryByText('Activation')).toBeNull()
    expect(screen.queryByText(/mark activated/i)).toBeNull()
    expect(screen.queryByText(/record request sent to cwd/i)).toBeNull()
    expect(screen.queryByText(/request sent to cwd/i)).toBeNull()
  })

  it('an activated device does not move the parcel: the rail stays on the courier axis', async () => {
    stub(DETAIL)
    renderPage()

    // The read says ACTIVATED (12:00) while the parcel is IN_TRANSIT (15:00).
    // The rail reports the parcel, so In transit is where it stands and no
    // delivery instant is claimed.
    expect((await screen.findAllByText(/in transit/i)).length).toBeGreaterThan(0)
    expect(screen.getByText('Delivered')).toBeTruthy()
    // The Delivered FactRow answers honestly.
    expect(screen.getByText('not yet')).toBeTruthy()
  })

  it('a COLLATERAL dispatch renders the same page with no activation surface', async () => {
    stub({ ...DETAIL, dispatchGroup: 'COLLATERAL', activationStatus: null, activationDate: null, activationTrail: [] })
    renderPage()

    expect(await screen.findByText('Dispatch lifecycle')).toBeTruthy()
    // D-16: standee-only is terminal at Delivered. It needs no "not applicable"
    // note now that no dispatch shows activation at all, so the collateral case
    // is simply the same page as any other.
    expect(screen.queryByText('Activation')).toBeNull()
    expect(screen.queryByText(/not applicable/i)).toBeNull()
    expect(screen.queryByText(/mark activated/i)).toBeNull()
    expect(screen.queryByText(/record request sent to cwd/i)).toBeNull()
  })

  it('a dispatch the courier has not touched still shows the whole ladder, early rungs reached', async () => {
    stub({
      ...DETAIL,
      awb: null,
      shptId: null,
      courierStatus: null,
      deliveryTrail: [],
      activationStatus: null,
      activationTrail: [],
    })
    renderPage()

    // The BRD's first rungs are real positions this dispatch has reached, and
    // the courier rungs ahead are drawn unreached rather than hidden.
    expect(await screen.findByText('Received')).toBeTruthy()
    expect(screen.getByText('Pending batch')).toBeTruthy()
    expect(screen.getByText('Delivered')).toBeTruthy()
    // The AWB fact answers honestly instead of claiming a parcel.
    expect(screen.getByText('not dispatched')).toBeTruthy()
  })

  // WHAT WAS ASKED FOR, which the analytics read does not carry. The page fetches
  // it from the batch that holds this dispatch, so the quantities and the UPI ID
  // an operator asks about are on screen without a new backend route.
  it('shows the ordered quantities and the UPI ID, taken from the batch that holds this dispatch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/batches/')) {
          return jsonResponse({
            batch: { id: 'btch_1', status: 'BATCHED', triggerReason: 'MANUAL', unitCount: 1, printVndr: null, triggeredByActor: null, triggerNote: null, createdAt: '2026-08-12T08:00:00.000Z', updatedAt: '2026-08-12T08:00:00.000Z' },
            entries: [{ asgnId: ASGN, merchantDisplayName: 'ALPHA', merchantLegalName: 'ALPHA LLP', bankReferenceCode: '3', bankDisplayName: 'GSCB', branchCode: '30', soundbox: true, standeeCount: 2, stickerCount: 4, poolStatus: 'BATCHED', dispatchState: 'SENT_TO_VENDOR', shipToSuperseded: false, dispatchGroup: 'SOUNDBOX' }],
            artifacts: [{ asgnId: ASGN, artifactType: 'STANDEE_IMG', assetReference: 's3://x', supersededAt: null, labelQr: 'upi://pay?pa=alpha@gscb&pn=ALPHA', labelDisplayName: 'ALPHA' }],
            printLayout: 'ONE_PER_PAGE',
          })
        }
        if (url.includes('/ops/devices')) return jsonResponse([])
        return jsonResponse({ ...DETAIL, batchId: 'btch_1' })
      }),
    )
    renderPage()

    expect(await screen.findByText(/Soundbox, 2 standee, 4 sticker/i)).toBeTruthy()
    expect(await screen.findByText('alpha@gscb')).toBeTruthy()
    // The branch code comes from the same row, and the batch is a link to the
    // page that owns it: nothing here asks the operator to copy an id.
    expect(screen.getByText('30')).toBeTruthy()
    expect(screen.getByRole('link', { name: /btch_1/ }).getAttribute('href')).toBe('/batches/btch_1')
  })

  it('names the bank as the requester, because a soundbox request comes from a bank and not a person', async () => {
    stub(DETAIL)
    renderPage()
    expect(await screen.findByText(/requested by/i)).toBeTruthy()
    expect(screen.getByText(/HDFC Bank/)).toBeTruthy()
  })

  it('survives a failed read instead of taking the page down with it', async () => {
    stub({ error: 'nope' }, 500)
    renderPage()
    expect(await screen.findByText(/could not read this dispatch/i)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------- //
// 19 Aug 2026: WHERE THE RAIL SAYS THE DISPATCH IS.
//
// Reported from a demo run: a batch reading "Batched" whose every row read
// "QR generated" opened a dispatch page that lit "Sent to print vendor" as the
// current rung. Nothing was wrong with the data. buildRail computed its index as
// ONE PAST the state (`composed ? 3` where 3 is SENT_TO_VENDOR), while the
// renderer reads that index as the rung the dispatch IS AT.
//
// The header pill is asserted in the same tests because it is now the SAME
// derivation: it used to render `courierStatus`, which is null until a courier
// reports, so every dispatch before its first scan showed a bare "-".
// ---------------------------------------------------------------------- //

/** A batch detail whose single entry sits at a given dispatch_state. */
function batchAt(dispatchState: string) {
  return {
    batch: { id: 'btch_1', status: 'BATCHED', triggerReason: 'MANUAL', unitCount: 1, printVndr: null, triggeredByActor: null, triggerNote: null, createdAt: '2026-08-12T08:00:00.000Z', updatedAt: '2026-08-12T08:00:00.000Z' },
    entries: [{ asgnId: ASGN, merchantDisplayName: 'ALPHA', merchantLegalName: 'ALPHA LLP', bankReferenceCode: '3', bankDisplayName: 'GSCB', branchCode: '30', soundbox: true, standeeCount: 0, stickerCount: 0, poolStatus: 'BATCHED', dispatchState, shipToSuperseded: false, dispatchGroup: 'SOUNDBOX' }],
    artifacts: [],
    printLayout: 'ONE_PER_PAGE',
  }
}

/** The read shape of a dispatch no courier has touched: batched, no parcel. */
const NOT_SHIPPED = {
  awb: null,
  shptId: null,
  courierStatus: null,
  deliveryDate: null,
  deliveryTrail: [],
  activationStatus: null,
  activationTrail: [],
}

function courierEvent(status: string, at: string) {
  return { status, courierTimestamp: at, statusSource: 'courier-file', sourceRef: 'vndr_1|file_1', receivedAt: at, overrideReason: null }
}

/**
 * The page's three reads plus its two writes, with the batch entry's
 * dispatch_state as the variable, because that column is what the rail's early
 * rungs are derived from.
 */
function stubStaged(dispatchState: string, detailOverrides: Record<string, unknown> = {}): FlagCall[] {
  const calls: FlagCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      // Order matters: the write path also contains '/ops/batches/'.
      if (url.includes('/send-to-vendor')) return jsonResponse({ deduped: false, sent: true })
      if (url.includes('/correct')) return jsonResponse({ recorded: true })
      if (url.includes('/ops/batches/')) return jsonResponse(batchAt(dispatchState))
      if (url.includes('/ops/devices')) return jsonResponse([])
      if (url.includes('/ops/damage-reasons')) return jsonResponse(REASONS)
      return jsonResponse({ ...DETAIL, batchId: 'btch_1', ...detailOverrides })
    }),
  )
  return calls
}

/** The rail's own rungs, so a query cannot match the header pill instead. */
function railRungs() {
  return within(screen.getByRole('list', { name: /lifecycle rail/i }))
}

/** A rung the rail has NOT reached renders its label muted. */
function isFutureRung(label: string): boolean {
  return railRungs().getByText(label).className.includes('text-muted-foreground')
}

/** The header pill, found by the design system's own class rather than by position. */
function headerPill(text: string): HTMLElement | undefined {
  return screen.getAllByText(text).find((el) => el.className.includes('pill'))
}

describe('DispatchDetailPage: the rail reports the rung the dispatch is at', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  // THE REPORTED BUG, asserted directly.
  it('a dispatch at QR_GENERATED highlights QR generated and leaves the print vendor ahead of it', async () => {
    stubStaged('QR_GENERATED', NOT_SHIPPED)
    renderPage()

    await screen.findByText('Dispatch lifecycle')
    await waitFor(() => {
      expect(isFutureRung('Sent to print vendor')).toBe(true)
    })
    expect(isFutureRung('QR generated')).toBe(false)
    // And the pill agrees, where it used to read "-" for want of a courier status.
    expect(headerPill('QR generated')).toBeTruthy()
  })

  it('a dispatch at SENT_TO_VENDOR sits on the print vendor, not on the courier rung after it', async () => {
    stubStaged('SENT_TO_VENDOR', NOT_SHIPPED)
    renderPage()

    await screen.findByText('Dispatch lifecycle')
    await waitFor(() => {
      expect(isFutureRung('Dispatched by vendor')).toBe(true)
    })
    expect(isFutureRung('Sent to print vendor')).toBe(false)
    expect(headerPill('Sent to print vendor')).toBeTruthy()
  })

  // THE SECOND DEFECT, same class, found while fixing the first: the rung map
  // omitted PICKED_UP and OUT_FOR_DELIVERY, and "not in the map" was the test for
  // "off the ladder", so an ordinary scan drew the parcel as a red failure stop.
  it('a parcel last scanned PICKED_UP stays on the ladder instead of drawing a failure stop', async () => {
    stubStaged('DISPATCHED_BY_VENDOR', {
      courierStatus: 'PICKED_UP',
      deliveryTrail: [courierEvent('PICKED_UP', '2026-08-12T09:00:00.000Z')],
    })
    renderPage()

    await screen.findByText('Dispatch lifecycle')
    // No appended stop anywhere on the page, and the ladder still runs ahead.
    await waitFor(() => {
      expect(headerPill('Dispatched by vendor')).toBeTruthy()
    })
    expect(screen.queryByText('Picked up')).toBeNull()
    expect(isFutureRung('Delivered')).toBe(true)
  })

  it('OUT_FOR_DELIVERY likewise folds onto the in-transit rung', async () => {
    stubStaged('DISPATCHED_BY_VENDOR', {
      courierStatus: 'OUT_FOR_DELIVERY',
      deliveryTrail: [courierEvent('OUT_FOR_DELIVERY', '2026-08-13T09:00:00.000Z')],
    })
    renderPage()

    await screen.findByText('Dispatch lifecycle')
    await waitFor(() => {
      expect(headerPill('In transit')).toBeTruthy()
    })
    expect(screen.queryByText('Out For Delivery')).toBeNull()
    expect(isFutureRung('Delivered')).toBe(true)
  })

  // The two that ARE off-ladder still are. Widening the rung map must not have
  // swallowed the terminal stops with it.
  it('RETURNED still closes the rail as a terminal stop', async () => {
    stubStaged('DISPATCHED_BY_VENDOR', {
      courierStatus: 'RETURNED',
      deliveryTrail: [courierEvent('IN_TRANSIT', '2026-08-13T09:00:00.000Z'), courierEvent('RETURNED', '2026-08-14T09:00:00.000Z')],
    })
    renderPage()

    expect(await screen.findByText('Returned to origin')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------- //
// 19 Aug 2026: the damage card is gated on the vendor having shipped it.
// A parcel still at the print vendor cannot have been damaged in the field.
// ---------------------------------------------------------------------- //

describe('DispatchDetailPage: the Damage card only exists once the parcel has shipped', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('is absent while the dispatch is still at QR generated', async () => {
    stubStaged('QR_GENERATED', NOT_SHIPPED)
    renderPage()

    await screen.findByText('Dispatch lifecycle')
    await waitFor(() => {
      expect(headerPill('QR generated')).toBeTruthy()
    })
    expect(screen.queryByText('Damage')).toBeNull()
    expect(screen.queryByRole('button', { name: /flag damage/i })).toBeNull()
  })

  it('is absent while the batch is only with the print vendor', async () => {
    stubStaged('SENT_TO_VENDOR', NOT_SHIPPED)
    renderPage()

    await screen.findByText('Dispatch lifecycle')
    await waitFor(() => {
      expect(headerPill('Sent to print vendor')).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: /flag damage/i })).toBeNull()
  })

  it('appears once the vendor has dispatched it', async () => {
    stubStaged('DISPATCHED_BY_VENDOR', {})
    renderPage()

    expect(await screen.findByRole('button', { name: /flag damage/i })).toBeTruthy()
  })

  // An RTO is usually an RTO because something was wrong with the parcel, so the
  // terminal stop must NOT read as "before the vendor shipped it".
  it('survives a terminal stop, which carries no rung of its own', async () => {
    stubStaged('DISPATCHED_BY_VENDOR', {
      courierStatus: 'RETURNED',
      deliveryTrail: [courierEvent('IN_TRANSIT', '2026-08-13T09:00:00.000Z'), courierEvent('RETURNED', '2026-08-14T09:00:00.000Z')],
    })
    renderPage()

    expect(await screen.findByRole('button', { name: /flag damage/i })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------- //
// 19 Aug 2026: Change status, from the card that shows the status.
//
// It owns no write. No per-dispatch status route exists, so each rung routes to
// its real owner: SENT_TO_VENDOR to the batch's send-to-vendor action, every
// courier rung to the shipment's correction. Rungs whose owner is unreachable
// are listed disabled with the reason, the same grammar the device status editor
// uses for the rungs a device has already passed.
// ---------------------------------------------------------------------- //

/** The labels the open picker offers, split by whether they can be chosen. */
async function openStatusPicker(): Promise<{ enabled: string[]; disabled: string[] }> {
  await userEvent.click(await screen.findByRole('button', { name: /change status/i }))
  await userEvent.click(screen.getByLabelText(/new status/i))
  const listbox = await screen.findByRole('listbox')
  const rows = within(listbox).getAllByRole('option')
  const label = (o: HTMLElement) => o.querySelector('span')?.textContent?.trim() ?? ''
  return {
    enabled: rows.filter((o) => o.getAttribute('aria-disabled') !== 'true').map(label),
    disabled: rows.filter((o) => o.getAttribute('aria-disabled') === 'true').map(label),
  }
}

describe('DispatchDetailPage: Change status', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('at QR generated, offers only the print vendor and says the whole batch moves', async () => {
    stubStaged('QR_GENERATED', NOT_SHIPPED)
    renderPage()
    await screen.findByText('Dispatch lifecycle')
    await waitFor(() => {
      expect(headerPill('QR generated')).toBeTruthy()
    })

    const { enabled, disabled } = await openStatusPicker()
    // The only rung with a reachable writer from here.
    expect(enabled).toEqual(['Sent to print vendor'])
    // The ladder still reads whole, rather than starting mid-way.
    expect(disabled).toContain('Received')
    expect(disabled).toContain('Dispatched by vendor')
    expect(screen.getByText(/sends the whole batch to the print vendor/i)).toBeTruthy()
  })

  it('saving that choice posts the batch send-to-vendor action', async () => {
    const calls = stubStaged('QR_GENERATED', NOT_SHIPPED)
    renderPage()
    await screen.findByText('Dispatch lifecycle')
    await waitFor(() => {
      expect(headerPill('QR generated')).toBeTruthy()
    })

    await userEvent.click(screen.getByRole('button', { name: /change status/i }))
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/batches/btch_1/send-to-vendor'))).toBe(true)
    })
    const write = calls.find((c) => c.url.includes('/send-to-vendor'))!
    expect((write.init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()
  })

  it('once a parcel exists, the courier rungs open and Save corrects the SHIPMENT', async () => {
    // DETAIL is IN_TRANSIT with a shipment, so Delivered is the next rung and the
    // two off-ladder stops are reachable from an in-flight parcel (D9).
    const calls = stubStaged('DISPATCHED_BY_VENDOR', {})
    renderPage()
    await screen.findByText('Dispatch lifecycle')

    const { enabled } = await openStatusPicker()
    expect(enabled).toEqual(['Delivered', 'Failed attempt', 'Returned to origin'])

    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/shipments/shpt_1/correct'))).toBe(true)
    })
    const write = calls.find((c) => c.url.includes('/correct'))!
    const body = JSON.parse(String(write.init.body)) as Record<string, unknown>
    // The status chosen, and an instant stamped here rather than typed.
    expect(body.status).toBe('DELIVERED')
    expect(typeof body.courierTimestamp).toBe('string')
    expect((write.init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()
  })

  // 19 Aug 2026: this page offers ONE status control, and the courier axis is
  // reached by clicking the AWB. Record courier update was here too (decision
  // D11), which meant one page wrote the same courier status from two controls,
  // the second an unlabelled pencil in the Fulfilment card. Asserted because the
  // control has already been placed and re-placed twice, so a third attempt
  // should fail a test rather than reach a demo.
  it('offers no second courier-update control beside Change status', async () => {
    stubStaged('DISPATCHED_BY_VENDOR', {})
    renderPage()
    await screen.findByText('Dispatch lifecycle')

    expect(screen.getByRole('button', { name: /change status/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /record a courier update/i })).toBeNull()
    expect(screen.queryByText('Record courier update')).toBeNull()
    // The AWB is the way through to the shipment that owns that axis.
    expect(screen.getByRole('link', { name: DETAIL.awb }).getAttribute('href')).toBe(
      `/shipments/${DETAIL.shptId}`,
    )
  })

  it('a rung whose writer is unreachable says so instead of failing on submit', async () => {
    // Sent to the vendor, no AWB yet: the courier rungs have no shipment to write
    // to, and the batch has already been sent.
    stubStaged('SENT_TO_VENDOR', NOT_SHIPPED)
    renderPage()
    await screen.findByText('Dispatch lifecycle')
    await waitFor(() => {
      expect(headerPill('Sent to print vendor')).toBeTruthy()
    })

    const { enabled, disabled } = await openStatusPicker()
    expect(enabled).toEqual([])
    expect(disabled).toContain('Delivered')
    // The reason is on the row, and the empty case explains itself.
    expect(screen.getAllByText(/needs the vendor awb/i).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------- //
// D-26 (damage workflow, B7): the Flag damage dialog. The damage-file upload
// is gone (D-25); the operator flags the dispatch they are looking at, with a
// reason from the master (label shown, code submitted, DP-5), a required
// remark, and, on a COLLATERAL leg only, the replacement's counts (DP-2). A
// SOUNDBOX leg mints exactly one replacement soundbox (D-27), so it carries
// NO count input. The route is POST /ops/records/:asgnId/flag-damage.
// ---------------------------------------------------------------------- //

const REASONS = [
  { id: 'dmgr_1', code: 'battery_issue', label: 'Battery issue', active: true, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
  { id: 'dmgr_2', code: 'retired_reason', label: 'Retired reason', active: false, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
]

interface FlagCall {
  url: string
  init: RequestInit
}

function stubFlag(detail: unknown, flagStatus = 201, flagBody: unknown = { childAsgnId: 'asgn_child1', caseStatus: 'Open' }): FlagCall[] {
  const calls: FlagCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('/ops/damage-reasons')) return jsonResponse(REASONS)
      if (url.includes('/flag-damage')) return jsonResponse(flagBody, flagStatus)
      return jsonResponse(detail)
    }),
  )
  return calls
}

async function openFlagDialog(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: /flag damage/i }))
  // The reason master loads when the dialog opens; wait for the real option.
  await screen.findByRole('option', { name: 'Battery issue' })
}

describe('DispatchDetailPage: the Flag damage dialog (D-26, B7)', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('opens from the Damage card, offering only ACTIVE reasons with the label shown', async () => {
    stubFlag(DETAIL)
    renderPage()
    await openFlagDialog()

    expect(screen.getByRole('dialog')).toBeTruthy()
    // Active row offered by LABEL; the inactive master row is not offered.
    expect(screen.getByRole('option', { name: 'Battery issue' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Retired reason' })).toBeNull()
  })

  it('a SOUNDBOX dispatch shows NO count inputs, and states the fixed one-replacement rule instead', async () => {
    stubFlag(DETAIL)
    renderPage()
    await openFlagDialog()

    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(screen.queryByLabelText(/standees/i)).toBeNull()
    expect(screen.getByText(/one replacement soundbox is raised, fixed per d-27/i)).toBeTruthy()
  })

  it('a COLLATERAL dispatch requires a total of at least one item before submit unlocks', async () => {
    stubFlag({ ...DETAIL, dispatchGroup: 'COLLATERAL', activationStatus: null, activationDate: null, activationTrail: [] })
    renderPage()
    await openFlagDialog()

    await userEvent.selectOptions(screen.getByLabelText(/reason/i), 'battery_issue')
    await userEvent.type(screen.getByLabelText(/remarks/i), 'standee torn in transit')

    // Counts default to 0 + 0: a replacement carrying nothing is not a
    // replacement, so submit stays locked.
    const confirm = () => screen.getByRole('button', { name: /open damage case/i }) as HTMLButtonElement
    expect(confirm().disabled).toBe(true)

    const standee = screen.getByLabelText(/standees/i)
    await userEvent.clear(standee)
    await userEvent.type(standee, '2')
    expect(confirm().disabled).toBe(false)
  })

  it('submit posts the reason CODE, the trimmed remarks and the counts, then links the child dispatch', async () => {
    const calls = stubFlag({ ...DETAIL, dispatchGroup: 'COLLATERAL', activationStatus: null, activationDate: null, activationTrail: [] })
    renderPage()
    await openFlagDialog()

    await userEvent.selectOptions(screen.getByLabelText(/reason/i), 'battery_issue')
    await userEvent.type(screen.getByLabelText(/remarks/i), '  standee torn in transit  ')
    const standee = screen.getByLabelText(/standees/i)
    await userEvent.clear(standee)
    await userEvent.type(standee, '2')
    await userEvent.click(screen.getByRole('button', { name: /open damage case/i }))

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes(`/ops/records/${ASGN}/flag-damage`))).toBe(true)
    })
    const write = calls.find((c) => c.url.includes('/flag-damage'))!
    const headers = write.init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBeTruthy()
    const body = JSON.parse(String(write.init.body)) as Record<string, unknown>
    // The CODE, never the label (DP-5); the remarks trimmed; the counts as
    // integers. No extra field: merchant and scope come from the principal.
    expect(body).toEqual({ reasonCode: 'battery_issue', remarks: 'standee torn in transit', standeeCount: 2, stickerCount: 0 })

    // The confirmation names the child and links its page.
    const link = await screen.findByRole('link', { name: /asgn_child1/ })
    expect(link.getAttribute('href')).toBe('/dispatches/asgn_child1')
  })

  it('a SOUNDBOX submit sends NO counts at all', async () => {
    const calls = stubFlag(DETAIL)
    renderPage()
    await openFlagDialog()

    await userEvent.selectOptions(screen.getByLabelText(/reason/i), 'battery_issue')
    await userEvent.type(screen.getByLabelText(/remarks/i), 'no sound on delivery')
    await userEvent.click(screen.getByRole('button', { name: /open damage case/i }))

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/flag-damage'))).toBe(true)
    })
    const write = calls.find((c) => c.url.includes('/flag-damage'))!
    const body = JSON.parse(String(write.init.body)) as Record<string, unknown>
    expect(body).toEqual({ reasonCode: 'battery_issue', remarks: 'no sound on delivery' })
  })

  it('a 409 reads as the DP-3 rule in words: a live case already exists', async () => {
    stubFlag(DETAIL, 409, { code: 'conflict' })
    renderPage()
    await openFlagDialog()

    await userEvent.selectOptions(screen.getByLabelText(/reason/i), 'battery_issue')
    await userEvent.type(screen.getByLabelText(/remarks/i), 'no sound on delivery')
    await userEvent.click(screen.getByRole('button', { name: /open damage case/i }))

    expect(await screen.findByText(/a live damage case already exists for this dispatch/i)).toBeTruthy()
    // No child link is claimed for a refused flag.
    expect(screen.queryByRole('link', { name: /asgn_child1/ })).toBeNull()
  })
})

// ---------------------------------------------------------------------- //
// 19 Aug 2026: the damage overlay survives a reload, in BOTH directions.
//
// Before this, "Damage case opened" came ONLY from in-memory state set right
// after a successful flag in the same tab: reload the page, or arrive fresh
// (the exact way an operator finds a dispatch after flagging it earlier), and
// the Flag damage button reappeared even though a live case existed server
// side. And the REPLACEMENT dispatch's own page named nothing about being one,
// where Inventory's device row already carries the amber "Replacement" pill
// for the same fact. Both are read from GET /ops/damage-cases, exactly the
// route InventoryPage already enriches from.
// ---------------------------------------------------------------------- //

const CHILD_ASGN = 'asgn_child1'

function openDamageCase(overrides: Record<string, unknown> = {}): unknown {
  return {
    asgnId: CHILD_ASGN,
    replacementOf: ASGN,
    merchantDisplayName: 'Flow Alpha Store',
    bankReferenceCode: '3',
    branchCode: '4',
    damageReason: 'battery_issue',
    bankRemarks: null,
    opsRemarks: 'test',
    caseStatus: 'Open',
    billable: false,
    demandState: 'awaiting-identity',
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  }
}

function stubWithDamageCases(detail: unknown, cases: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/ops/damage-cases')) return jsonResponse(cases)
      if (url.includes('/ops/damage-reasons')) return jsonResponse(REASONS)
      return jsonResponse(detail)
    }),
  )
}

function renderPageFor(asgn: string) {
  return render(
    <MemoryRouter initialEntries={[`/dispatches/${asgn}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/dispatches/:asgnId" element={<DispatchDetailPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('DispatchDetailPage: the damage overlay survives a reload (19 Aug 2026)', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('the ORIGINAL shows "Damage case opened" on a fresh load, with no click at all', async () => {
    stubWithDamageCases(DETAIL, [openDamageCase()])
    renderPage()

    expect(await screen.findByText(/damage case opened/i)).toBeTruthy()
    const link = await screen.findByRole('link', { name: CHILD_ASGN })
    expect(link.getAttribute('href')).toBe(`/dispatches/${CHILD_ASGN}`)
    // The button this note replaces must be gone, not merely coexisting.
    expect(screen.queryByRole('button', { name: /flag damage/i })).toBeNull()
  })

  it('the ORIGINAL still offers Flag damage when the only case on record is Closed', async () => {
    stubWithDamageCases(DETAIL, [openDamageCase({ caseStatus: 'Closed' })])
    renderPage()

    expect(await screen.findByRole('button', { name: /flag damage/i })).toBeTruthy()
    expect(screen.queryByText(/damage case opened/i)).toBeNull()
  })

  it('the REPLACEMENT dispatch names what it replaces, on its own page', async () => {
    stubWithDamageCases({ ...DETAIL, dispatchId: CHILD_ASGN }, [openDamageCase()])
    renderPageFor(CHILD_ASGN)

    expect(await screen.findByText('Replacement')).toBeTruthy()
    expect(screen.getByText(/non-billable replacement for/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: ASGN })
    expect(link.getAttribute('href')).toBe(`/dispatches/${ASGN}`)
    expect(screen.getByText(/battery_issue/)).toBeTruthy()
  })

  it('the REPLACEMENT card survives its case closing: being a replacement is permanent', async () => {
    stubWithDamageCases({ ...DETAIL, dispatchId: CHILD_ASGN }, [openDamageCase({ caseStatus: 'Closed' })])
    renderPageFor(CHILD_ASGN)

    expect(await screen.findByText('Replacement')).toBeTruthy()
    expect(screen.getByText(/case closed/i)).toBeTruthy()
  })
})
