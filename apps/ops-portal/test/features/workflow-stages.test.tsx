import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'
import { BatchStage } from '../../src/features/workflow/stages/BatchStage.js'
import { GenerateStage } from '../../src/features/workflow/stages/GenerateStage.js'
import { PrintStage } from '../../src/features/workflow/stages/PrintStage.js'
import { DispatchStage } from '../../src/features/workflow/stages/DispatchStage.js'
import { DeliveryStage } from '../../src/features/workflow/stages/DeliveryStage.js'
import { ActivationStage } from '../../src/features/workflow/stages/ActivationStage.js'
import { NeedsYouBlock } from '../../src/features/workflow/NeedsYouBlock.js'
import { deriveWorkflow, type WorkflowSnapshot } from '../../src/features/workflow/workflowStage.js'
import { fmtDateTime } from '../../src/ui/format.js'

// The stage bodies. What these pin hardest is the three claims the original
// mockup made that the system cannot back: a mark-as-sent button (dispatch_state
// advances on its own at the end of the composition transaction), a "package
// downloaded" claim (the vendor pulls under their own credential through a
// stateless route and nothing records it), and a percentage on Generate
// (composition is atomic, so there is no partial state to compute one from).
// A test asserting a control is ABSENT is the only way an honest screen stays
// honest under later edits.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const BATCH_DETAIL = {
  batch: {
    id: 'btch_1', status: 'FORMED', triggerReason: 'LOT_SIZE', unitCount: 3, printVndr: 'vndr_1',
    triggeredByActor: null, triggerNote: null,
    createdAt: '2026-08-11T09:00:00.000Z', updatedAt: '2026-08-11T09:00:00.000Z',
  },
  entries: [
    { asgnId: 'asgn_1', merchantDisplayName: 'Acme', merchantLegalName: 'ACME LTD', bankReferenceCode: 'HDFC001',
      bankDisplayName: 'HDFC Bank', branchCode: 'BR1', soundbox: true, standeeCount: 0, stickerCount: 0,
      poolStatus: 'BATCHED', dispatchState: 'SENT_TO_VENDOR', shipToSuperseded: false, dispatchGroup: 'SOUNDBOX' },
  ],
  artifacts: [] as { asgnId: string; artifactType: string; assetReference: string; supersededAt: string | null }[],
  printLayout: 'ONE_PER_PAGE',
}

function snapshot(over: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    mode: 'batch', pools: [], batchDetail: BATCH_DETAIL, journey: null,
    hasPreview: false, hasCommitted: false, commitAwaitingPool: false, elapsedMsInStage: 0, ...over,
  }
}

function wrap(node: React.ReactNode) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>{node}</AuthProvider>
    </MemoryRouter>,
  )
}

describe('BatchStage', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  // Pool mode EXPLAINS AND POINTS, and carries no trigger of its own. It used to
  // render BatchablePools here, which put the workspace's only trigger behind a
  // stage pool mode reaches only after an in-session commit; that control now
  // lives in LiveWorkView, which is on screen on every load. Rendering it in both
  // would put two reason fields and two Trigger buttons on one page for one pool,
  // because this stage and LiveWorkView are on screen together at step 3.
  it('explains batching in pool mode and carries NO trigger of its own', async () => {
    // A POOLED row on the wire, so a BatchablePools left behind here would have
    // something to render a reason field and a Trigger button FOR. Answering with
    // an empty list would make the two absence assertions below pass whether the
    // component is here or not.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) =>
        String(input).includes('/ops/pool')
          ? jsonResponse([
              {
                asgnId: 'asgn_1', merchantDisplayName: 'Acme', merchantLegalName: 'ACME LTD',
                bankReferenceCode: 'HDFC001', bankDisplayName: 'HDFC Bank', branchCode: 'BR1',
                soundbox: true, standeeCount: 0, stickerCount: 0, poolStatus: 'POOLED',
                dispatchState: null, shipToSuperseded: false, dispatchGroup: 'SOUNDBOX', batch: null,
                createdAt: '2026-08-10T09:00:00.000Z', tenantId: 'tnnt_1', programId: 'prg_1',
              },
            ])
          : jsonResponse([]),
      ),
    )
    wrap(
      <BatchStage
        derived={deriveWorkflow(snapshot({ mode: 'pool', batchDetail: null }))}
        batchDetail={null}
        btchId=""
        onChanged={() => {}}
      />,
    )
    // Let anything that DID mount finish its own read before the absences are
    // claimed, so this cannot pass merely by being early.
    await act(async () => { await new Promise((r) => { setTimeout(r, 0) }) })

    expect(screen.getByText(/forms on its own/i)).toBeTruthy()
    // Where the one control is, said out loud rather than left to be hunted for.
    expect(screen.getByText(/pool card above/i)).toBeTruthy()
    expect(screen.queryByLabelText(/reason/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /trigger batch/i })).toBeNull()
  })

  it('summarises a formed batch, and omits the reason line when no human fired it', () => {
    wrap(
      <BatchStage
        derived={deriveWorkflow(snapshot())}
        batchDetail={BATCH_DETAIL}
        btchId="btch_1"
        onChanged={() => {}}
      />,
    )
    expect(screen.getByText('btch_1')).toBeTruthy()
    // The records tile is labelled records, never units or devices: no device is
    // attached to a batch until the print vendor's return sheet binds one.
    expect(screen.getByText(/records/i)).toBeTruthy()
    expect(screen.getByText('Lot Size')).toBeTruthy()
    // triggerNote is null for LOT_SIZE and MAX_WAIT, because nothing human fired
    // them. A "Reason: none" line on every automatic batch would be noise
    // pretending to be a record.
    expect(screen.queryByText(/reason given/i)).toBeNull()
  })
})

describe('GenerateStage', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('shows an indeterminate wait with an elapsed count and NO percentage', () => {
    const { container } = wrap(<GenerateStage derived={deriveWorkflow(snapshot({ elapsedMsInStage: 6000 }))} batchDetail={BATCH_DETAIL} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.getByText(/you do not need to do anything/i)).toBeTruthy()
    expect(screen.getByText(/6s/)).toBeTruthy()
    // Composition is atomic. A percentage would be a number the system does not have.
    expect(screen.queryByText(/%/)).toBeNull()
    // AND NO FRACTION EITHER. Compose and dispatch run in one db.$transaction, so
    // either every artifact exists or none does. An N of M is exactly as false as a
    // percentage, and only banning the percent sign would let one in.
    expect(container.textContent).not.toMatch(/\d+\s*(of|\/)\s*\d+/)
  })

  it('flips to the REAL artifact counts once they land, grouped by type', () => {
    const detail = { ...BATCH_DETAIL, artifacts: [
      { asgnId: 'asgn_1', artifactType: 'SOUNDBOX_IMG', assetReference: 'r1', supersededAt: null },
      { asgnId: 'asgn_2', artifactType: 'SOUNDBOX_IMG', assetReference: 'r2', supersededAt: null },
      { asgnId: 'asgn_3', artifactType: 'STANDEE_IMG', assetReference: 'r3', supersededAt: null },
    ] }
    wrap(<GenerateStage derived={deriveWorkflow(snapshot({ batchDetail: detail }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.getByText(/2/)).toBeTruthy()
    expect(screen.getByText(/soundbox/i)).toBeTruthy()
    expect(screen.getByText(/standee/i)).toBeTruthy()
  })

  it('names the likely cause once generation has stalled, instead of spinning forever', () => {
    wrap(<GenerateStage derived={deriveWorkflow(snapshot({ elapsedMsInStage: 120_000 }))} batchDetail={BATCH_DETAIL} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText(/active print vendor/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /master data/i })).toBeTruthy()
  })
})

describe('PrintStage', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  const detail = { ...BATCH_DETAIL, artifacts: [
    { asgnId: 'asgn_1', artifactType: 'SOUNDBOX_IMG', assetReference: 'r1', supersededAt: null },
  ] }

  // The three claims the original mockup made that the system cannot back.
  //
  // Pinned as a SET rather than as phrase greps. `/mark as sent/i` would happily
  // pass a future button labelled "Send to vendor", and the absence of that button
  // is the whole point of the stage: dispatch_state advances to SENT_TO_VENDOR at
  // the end of the composition transaction, and no handoff write exists anywhere to
  // back a control. Asserting the complete control set fails on ANY button added for
  // ANY reason, which is what durable means here.
  it('renders EXACTLY the two download buttons and no other control', () => {
    wrap(<PrintStage derived={deriveWorkflow(snapshot({ batchDetail: detail }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.getAllByRole('button').map((b) => b.textContent?.trim())).toEqual([
      'Soundbox Excel',
      'Soundbox PDF',
    ])
  })

  it('never claims the vendor downloaded anything, because nothing records that', () => {
    const { container } = wrap(<PrintStage derived={deriveWorkflow(snapshot({ batchDetail: detail }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.queryByText(/package downloaded/i)).toBeNull()
    // The vendor pulls under their own credential through a stateless route, and the
    // only trace is a 6e record in the auth context that ops-edge may not read. So no
    // wording anywhere may put the vendor in the past tense.
    expect(container.textContent).not.toMatch(/pulled|downloaded|collected|picked up by/i)
  })

  // The ruling with the most reasoning behind it. This stage rendered NO timestamp
  // at all until the journey read could answer one, because the only alternatives
  // were batch.createdAt (when the batch FORMED, earlier and a different fact) and
  // batch.updatedAt (which moves for unrelated reasons), and either would have put a
  // plausible wrong time on screen. BatchJourneyView now carries sentToVendorAt, the
  // earliest non-null sent_to_vendor_at across the batch, so BOTH directions matter:
  // a real instant renders, and its absence still renders as an absence.
  it('shows no date at all when no handoff time has been recorded', () => {
    // journey is null on this snapshot, so facts.sentToVendorAt is null.
    const { container } = wrap(<PrintStage derived={deriveWorkflow(snapshot({ batchDetail: detail }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    // Nothing date-shaped at all, in any format fmtDateTime or fmtDate can produce.
    expect(container.textContent).not.toMatch(/\d{1,2} [A-Z][a-z]{2}/)
    // And specifically not the batch's own createdAt, so a future substitution of it
    // fails loudly here rather than shipping as a plausible wrong time.
    expect(container.textContent).not.toContain(fmtDateTime(BATCH_DETAIL.batch.createdAt))
    expect(container.textContent).toMatch(/no handoff time has been recorded/i)
  })

  it('renders the recorded handoff instant, and it is NOT the batch createdAt', () => {
    const sentAt = '2026-08-11T14:12:00.000Z'
    const j = {
      batchId: 'btch_1',
      counts: { total: 4, deliverableAndActivatable: 4, sentToVendor: 4, dispatched: 0, delivered: 0, activated: 0 },
      courier: { pickedUp: 0, inTransit: 0, outForDelivery: 0, delivered: 0, exception: 0 },
      activation: { awaiting: 0, activated: 0, failed: 0, simActivated: null as null },
      awaitingActivation: [],
      sentToVendorAt: sentAt,
      watermark: { asOf: '2026-08-11T15:00:00.000Z', perTopic: {} },
    }
    const { container } = wrap(<PrintStage derived={deriveWorkflow(snapshot({ batchDetail: detail, journey: j }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    expect(container.textContent).toContain(fmtDateTime(sentAt))
    // The two are DIFFERENT instants, which is the whole reason this field exists
    // rather than the batch's own createdAt being reused.
    expect(container.textContent).not.toContain(fmtDateTime(BATCH_DETAIL.batch.createdAt))
    expect(container.textContent).not.toMatch(/no handoff time has been recorded/i)
  })

  it('says the vendor can pull it now, and that the downloads are for checking', () => {
    wrap(<PrintStage derived={deriveWorkflow(snapshot({ batchDetail: detail }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.getByText(/can pull/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /soundbox excel/i })).toBeTruthy()
  })
})

describe('DispatchStage', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('counts what has been returned and warns that one request can carry two AWBs', () => {
    const journey = {
      batchId: 'btch_1',
      counts: { total: 4, deliverableAndActivatable: 4, sentToVendor: 4, dispatched: 3, delivered: 0, activated: 0 },
      courier: { pickedUp: 3, inTransit: 0, outForDelivery: 0, delivered: 0, exception: 0 },
      activation: { awaiting: 0, activated: 0, failed: 0, simActivated: null as null },
      awaitingActivation: [],
      sentToVendorAt: null,
      watermark: { asOf: '2026-08-11T09:00:00.000Z', perTopic: {} },
    }
    const detail = { ...BATCH_DETAIL, artifacts: [{ asgnId: 'a', artifactType: 'SOUNDBOX_IMG', assetReference: 'r', supersededAt: null }] }
    wrap(<DispatchStage derived={deriveWorkflow(snapshot({ batchDetail: detail, journey }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.getByText(/two awbs/i)).toBeTruthy()
    expect(screen.getByText(/3/)).toBeTruthy()
  })
})

describe('DeliveryStage', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('shows the courier fan-out rather than one status for the batch', () => {
    const journey = {
      batchId: 'btch_1',
      counts: { total: 10, deliverableAndActivatable: 10, sentToVendor: 10, dispatched: 10, delivered: 7, activated: 0 },
      courier: { pickedUp: 1, inTransit: 1, outForDelivery: 1, delivered: 7, exception: 0 },
      activation: { awaiting: 7, activated: 0, failed: 0, simActivated: null as null },
      awaitingActivation: [],
      sentToVendorAt: null,
      watermark: { asOf: '2026-08-11T09:00:00.000Z', perTopic: {} },
    }
    const detail = { ...BATCH_DETAIL, artifacts: [{ asgnId: 'a', artifactType: 'SOUNDBOX_IMG', assetReference: 'r', supersededAt: null }] }
    wrap(<DeliveryStage derived={deriveWorkflow(snapshot({ batchDetail: detail, journey }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.getByText(/in transit/i)).toBeTruthy()
    expect(screen.getByText(/out for delivery/i)).toBeTruthy()
    expect(screen.getByText(/picked up/i)).toBeTruthy()
  })

  it('badges the analytics freshness rather than presenting the numbers as live', () => {
    const journey = {
      batchId: 'btch_1',
      counts: { total: 1, deliverableAndActivatable: 1, sentToVendor: 1, dispatched: 1, delivered: 0, activated: 0 },
      courier: { pickedUp: 1, inTransit: 0, outForDelivery: 0, delivered: 0, exception: 0 },
      activation: { awaiting: 0, activated: 0, failed: 0, simActivated: null as null },
      awaitingActivation: [],
      sentToVendorAt: null,
      watermark: { asOf: '2026-08-11T09:00:00.000Z', perTopic: {} },
    }
    const detail = { ...BATCH_DETAIL, artifacts: [{ asgnId: 'a', artifactType: 'SOUNDBOX_IMG', assetReference: 'r', supersededAt: null }] }
    wrap(<DeliveryStage derived={deriveWorkflow(snapshot({ batchDetail: detail, journey }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.getByText(/as of/i)).toBeTruthy()
  })
})

describe('ActivationStage', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  const journey = {
    batchId: 'btch_1',
    counts: { total: 2, deliverableAndActivatable: 2, sentToVendor: 2, dispatched: 2, delivered: 2, activated: 0 },
    courier: { pickedUp: 0, inTransit: 0, outForDelivery: 0, delivered: 2, exception: 0 },
    activation: { awaiting: 2, activated: 0, failed: 0, simActivated: null as null },
    awaitingActivation: [
      { dispatchId: 'asgn_a', merchantDisplay: 'Acme', awb: 'AWB1', deliveryDate: '2026-08-10T10:00:00.000Z' },
      { dispatchId: 'asgn_b', merchantDisplay: 'Kirana', awb: 'AWB2', deliveryDate: '2026-08-10T11:00:00.000Z' },
    ],
    sentToVendorAt: null,
    watermark: { asOf: '2026-08-11T09:00:00.000Z', perTopic: {} },
  }
  const detail = { ...BATCH_DETAIL, artifacts: [{ asgnId: 'a', artifactType: 'SOUNDBOX_IMG', assetReference: 'r', supersededAt: null }] }

  it('lists the delivered records awaiting activation', () => {
    wrap(<ActivationStage derived={deriveWorkflow(snapshot({ batchDetail: detail, journey }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.getByText('Acme')).toBeTruthy()
    expect(screen.getByText('Kirana')).toBeTruthy()
  })

  it('marks ONE record per click, against the existing per-dispatch write', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(String(url)); return jsonResponse({ activated: true }) }))
    const onChanged = vi.fn()
    wrap(<ActivationStage derived={deriveWorkflow(snapshot({ batchDetail: detail, journey }))} batchDetail={detail} btchId="btch_1" onChanged={onChanged} />)
    const buttons = screen.getAllByRole('button', { name: /mark activated/i })
    expect(buttons).toHaveLength(2)
    await userEvent.click(buttons[0]!)
    await vi.waitFor(() => { expect(calls.some((u) => u.includes('/ops/assignments/activate'))).toBe(true) })
  })

  // A set assertion for the same reason as PrintStage's: `/mark all/i` alone would
  // pass a future button labelled "Activate batch" or "Mark remaining". The rule is
  // that the ONLY controls here are one per row, because markActivated marks exactly
  // one dispatch and a client-side loop failing halfway leaves an ambiguous half-done
  // state nobody can read back.
  it('offers NO bulk mark-all, because no bulk write exists', () => {
    wrap(<ActivationStage derived={deriveWorkflow(snapshot({ batchDetail: detail, journey }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.queryByRole('button', { name: /mark all/i })).toBeNull()
    expect(screen.getAllByRole('button').map((b) => b.textContent?.trim())).toEqual([
      'Mark activated',
      'Mark activated',
    ])
  })

  it('renders SIM activation as not available yet, and never as zero', () => {
    wrap(<ActivationStage derived={deriveWorkflow(snapshot({ batchDetail: detail, journey }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.getByText(/not available yet/i)).toBeTruthy()
  })
})

describe('NeedsYouBlock', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  // The counts come from portal-wide reads with no batch scope, so labelling
  // them as this batch's errors would be a lie.
  it('labels itself portal-wide, never as belonging to one batch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([{ id: 'q1', fileId: 'f', rowNo: 1, reasonCode: 'missing_mobile', detail: null, createdAt: '2026-08-11T09:00:00.000Z', resolvedAt: null, resolvedByActor: null }])))
    wrap(<NeedsYouBlock />)
    expect(await screen.findByText(/across the portal/i)).toBeTruthy()
  })

  // ASSERT ON THE SETTLED RENDER, NOT ON THE FIRST TICK. This is the only guard on the
  // no-permanent-zero-card rule, and it took two goes to make it able to fail.
  //
  // Draft 1 wrapped the assertion in vi.waitFor, which resolved on attempt one:
  // `counts === null` renders null before any response is applied, so "no Needs you
  // text" was already true. Draft 2 waited for three fetch calls first, which was
  // still not enough: the call count hits three inside the promise chain, one await
  // BEFORE React has re-rendered with the resolved state, so an implementation that
  // rendered "Needs you / 0 / 0 / 0" still passed. Confirmed by mutation: deleting the
  // `total === 0` guard from the component left both drafts green.
  //
  // So: testing-library's waitFor (which flushes React work through act, unlike
  // vi.waitFor) for the fetch count, then an explicit act flush for the state update
  // those fetches queue. The mutation fails after this, which is the only evidence
  // worth having.
  it('renders nothing at all when there is nothing to act on', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)
    const { container } = wrap(<NeedsYouBlock />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(3) })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).not.toMatch(/needs you/i)
    // And no bare zero smuggled in under some other heading.
    expect(container.textContent).not.toMatch(/\b0\b/)
    // The card genuinely renders when there IS something, which the sibling test
    // proves, so this is an empty-state assertion and not a never-renders one.
    expect(container.textContent).toBe('')
  })
})
