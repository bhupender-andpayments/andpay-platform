import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
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
    hasPreview: false, hasCommitted: false, elapsedMsInStage: 0, ...over,
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

  // Pool mode REUSES BatchablePools rather than reimplementing the trigger form,
  // the per-pool reason field, the grouping or the stock advisory. Finding that
  // component's own heading is what proves it was reused.
  it('reuses the existing batchable-pools control in pool mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])))
    wrap(
      <BatchStage
        derived={deriveWorkflow(snapshot({ mode: 'pool', batchDetail: null }))}
        batchDetail={null}
        btchId=""
        onChanged={() => {}}
      />,
    )
    expect(await screen.findByText(/ready to batch/i)).toBeTruthy()
    expect(screen.getByText(/forms on its own/i)).toBeTruthy()
  })
})

describe('GenerateStage', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('shows an indeterminate wait with an elapsed count and NO percentage', () => {
    wrap(<GenerateStage derived={deriveWorkflow(snapshot({ elapsedMsInStage: 6000 }))} batchDetail={BATCH_DETAIL} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.getByText(/you do not need to do anything/i)).toBeTruthy()
    expect(screen.getByText(/6s/)).toBeTruthy()
    // Composition is atomic. A percentage would be a number the system does not have.
    expect(screen.queryByText(/%/)).toBeNull()
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
  it('offers NO mark-as-sent button, because SENT_TO_VENDOR is set automatically', () => {
    wrap(<PrintStage derived={deriveWorkflow(snapshot({ batchDetail: detail }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.queryByRole('button', { name: /mark as sent/i })).toBeNull()
  })

  it('never claims the vendor downloaded anything, because nothing records that', () => {
    wrap(<PrintStage derived={deriveWorkflow(snapshot({ batchDetail: detail }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.queryByText(/package downloaded/i)).toBeNull()
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
      counts: { total: 4, sentToVendor: 4, dispatched: 3, delivered: 0, activated: 0 },
      courier: { pickedUp: 3, inTransit: 0, outForDelivery: 0, delivered: 0, exception: 0 },
      activation: { awaiting: 0, activated: 0, failed: 0, simActivated: null as null },
      awaitingActivation: [],
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
      counts: { total: 10, sentToVendor: 10, dispatched: 10, delivered: 7, activated: 0 },
      courier: { pickedUp: 1, inTransit: 1, outForDelivery: 1, delivered: 7, exception: 0 },
      activation: { awaiting: 7, activated: 0, failed: 0, simActivated: null as null },
      awaitingActivation: [],
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
      counts: { total: 1, sentToVendor: 1, dispatched: 1, delivered: 0, activated: 0 },
      courier: { pickedUp: 1, inTransit: 0, outForDelivery: 0, delivered: 0, exception: 0 },
      activation: { awaiting: 0, activated: 0, failed: 0, simActivated: null as null },
      awaitingActivation: [],
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
    counts: { total: 2, sentToVendor: 2, dispatched: 2, delivered: 2, activated: 0 },
    courier: { pickedUp: 0, inTransit: 0, outForDelivery: 0, delivered: 2, exception: 0 },
    activation: { awaiting: 2, activated: 0, failed: 0, simActivated: null as null },
    awaitingActivation: [
      { dispatchId: 'asgn_a', merchantDisplay: 'Acme', awb: 'AWB1', deliveryDate: '2026-08-10T10:00:00.000Z' },
      { dispatchId: 'asgn_b', merchantDisplay: 'Kirana', awb: 'AWB2', deliveryDate: '2026-08-10T11:00:00.000Z' },
    ],
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

  it('offers NO bulk mark-all, because no bulk write exists', () => {
    wrap(<ActivationStage derived={deriveWorkflow(snapshot({ batchDetail: detail, journey }))} batchDetail={detail} btchId="btch_1" onChanged={() => {}} />)
    expect(screen.queryByRole('button', { name: /mark all/i })).toBeNull()
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

  it('renders nothing at all when there is nothing to act on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])))
    const { container } = wrap(<NeedsYouBlock />)
    await vi.waitFor(() => { expect(container.textContent).not.toMatch(/needs you/i) })
  })
})
