import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { DispatchDetailPage } from '../../src/features/dispatches/DispatchDetailPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The per-dispatch detail page: ONE horizontal rail over the BRD delivery
// ladder, no activation (2026-08-15 ruling: parcels deliver, devices activate,
// and the device page owns that axis). The response shape below mirrors the
// edge's dispatchDetail route (apps/ops-edge/src/reports.controller.ts);
// nothing is invented here.

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

  // REVISED 16 Aug 2026 (UAT walkthrough finding A3/A4). This test used to pin
  // "no activation anywhere on the page", reasoning that a dispatch does not
  // activate, its devices do, on the device page. Half of that held: the RAIL
  // is the parcel's and activation must never be a rung on it, which this test
  // still pins. The other half did not: the device page never gained the
  // actions, requestActivation had no consumer anywhere, so the D-16 state
  // REQUEST_SENT_TO_CWD was unreachable from the whole UI, and D-16/T4.5
  // records that the per-dispatch page carries BOTH axes. Activation is back
  // as its OWN CARD beside the facts, never on the rail.
  it('renders the delivery ladder as one rail, with activation as its own card and never a rung', async () => {
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

    // The activation CARD is present (this DETAIL is ACTIVATED, so no buttons).
    expect(screen.getByText('Activation')).toBeTruthy()
    expect(screen.queryByText(/mark activated/i)).toBeNull()
    expect(screen.queryByText(/record request sent to cwd/i)).toBeNull()

    // The rail itself stays the parcel's: no activation rung inside it.
    const rail = screen.getByText('Dispatch lifecycle').closest('div')?.parentElement
    expect(rail?.textContent ?? '').not.toMatch(/request sent to cwd/i)
  })

  it('an unactivated soundbox offers BOTH activation actions; a request-sent one offers mark only', async () => {
    stub({ ...DETAIL, activationStatus: null, activationDate: null, activationTrail: [] })
    renderPage()
    expect(await screen.findByText('Activation')).toBeTruthy()
    expect(screen.getByText(/record request sent to cwd/i)).toBeTruthy()
    expect(screen.getByText(/mark activated/i)).toBeTruthy()
    expect(screen.getByText('no request sent yet')).toBeTruthy()

    cleanup()
    stub({ ...DETAIL, activationStatus: 'REQUEST_SENT_TO_CWD', activationDate: null, activationTrail: [] })
    renderPage()
    expect(await screen.findByText('Activation')).toBeTruthy()
    expect(screen.queryByText(/record request sent to cwd/i)).toBeNull()
    expect(screen.getByText(/mark activated/i)).toBeTruthy()
    expect(screen.getByText('Request sent to CWD')).toBeTruthy()
  })

  it('a request the ANALYTICS fold has not seen still shows: the TMS trail wins over a null fold', async () => {
    // No activation-request fact exists (PLAN.md section 7 item 8), so the
    // fold's activationStatus stays null forever for this state; the trail is
    // the TMS read and is the truth the card must follow (V-4 posture).
    stub({
      ...DETAIL,
      activationStatus: null,
      activationDate: null,
      activationTrail: [
        { status: 'REQUEST_SENT_TO_CWD', occurredAt: '2026-08-16T04:24:00.000Z', statusSource: 'ops:request-activation', actorId: null, recordedAt: '2026-08-16T04:24:00.000Z' },
      ],
    })
    renderPage()
    expect(await screen.findByText('Activation')).toBeTruthy()
    // The status line reports the request, and the request button is GONE.
    expect(screen.getAllByText('Request sent to CWD').length).toBeGreaterThan(0)
    expect(screen.queryByText(/record request sent to cwd/i)).toBeNull()
    expect(screen.getByText(/mark activated/i)).toBeTruthy()
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

  it('a COLLATERAL dispatch states that activation is not applicable and offers NO write', async () => {
    stub({ ...DETAIL, dispatchGroup: 'COLLATERAL', activationStatus: null, activationDate: null, activationTrail: [] })
    renderPage()

    expect(await screen.findByText('Dispatch lifecycle')).toBeTruthy()
    // D-16: standee-only is terminal at Delivered. Saying so beats an operator
    // hunting for a button that would only ever 409.
    expect(screen.getByText(/a collateral consignment ends at Delivered/i)).toBeTruthy()
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
            batch: { id: 'btch_1', triggerReason: 'MANUAL', unitCount: 1, printVndr: null, triggeredByActor: null, triggerNote: null, createdAt: '2026-08-12T08:00:00.000Z', updatedAt: '2026-08-12T08:00:00.000Z' },
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
