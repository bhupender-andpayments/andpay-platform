import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'
import { WorkflowPage } from '../../src/features/workflow/WorkflowPage.js'

// The workspace page: the one place that fetches, the one place that holds the
// bank-upload state, and the one place allowed to read the clock.
//
// TWO FIRST-IN-REPO IDIOMS live here, both for the same reason: `vi.useFakeTimers`
// has no precedent anywhere in this repository, and userEvent v14 needs an
// `advanceTimers` wiring no existing test does, so faking the clock would have
// been a new harness rather than a new test.
//
//   1. The poll intervals are INJECTED (`pollIntervals`), and the tests pass
//      single-digit milliseconds and assert against a call-recording fetch stub.
//      The two intervals are always set FAR apart (10 against 5000) so the
//      assertion discriminates: at a 10ms fast tick a one-second window sees many
//      requests, and at a 5000ms one it sees none, so "polls fast" cannot pass by
//      accident on a page that polled slowly.
//   2. Hiding the tab is `Object.defineProperty(document, 'visibilityState', ...)`
//      plus a dispatched 'visibilitychange' Event, because jsdom's
//      visibilityState is a read-only getter. It is restored in afterEach: the
//      property survives cleanup(), so leaving it hidden would silently switch
//      off polling for every test after it in this file.
//
// The async-settle pitfall this file is careful about: `vi.waitFor` does NOT
// flush React work, so it is used only to wait on the CALL RECORD (a plain
// array), and `waitFor` from @testing-library/react is used whenever a
// re-render has to have happened.

interface Call {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function headerValue(call: Call, name: string): string | null {
  const headers = call.init.headers as Record<string, string>
  return headers[name] ?? null
}

// jsdom's Blob implements neither text() nor arrayBuffer(), only FileReader, so
// the multipart file part is read back the way the deleted bank transport test
// read it (and the vendor-portal precedent before that).
function readFormFileText(form: FormData): Promise<string> {
  const filePart = form.get('file')
  if (!(filePart instanceof Blob)) throw new Error('expected a file part')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('failed to read the file part'))
    reader.readAsText(filePart)
  })
}

function makeFile(content: string, name = 'bank.csv'): File {
  return new File([content], name, { type: 'text/csv' })
}

// 6 MB of zero bytes, past the 5 MB cap. The content is irrelevant: the size
// check must reject before any network call, which is the whole assertion.
function makeOversizedFile(name = 'huge.csv'): File {
  return new File([new Uint8Array(6 * 1024 * 1024)], name, { type: 'text/csv' })
}

// Row shapes are copied from services/fulfillment/src/ops-read.ts (PoolEntryRow,
// BatchRow, BatchDetailView, BatchingConfigRow) and services/analytics/src/
// mediation.ts (BatchJourneyView), never invented here.
function poolRow(asgnId: string, over: Record<string, unknown> = {}) {
  return {
    asgnId,
    merchantDisplayName: 'Kirana Corner',
    merchantLegalName: 'KIRANA CORNER PRIVATE LIMITED',
    bankReferenceCode: 'GSCB001',
    bankDisplayName: 'GSCB',
    branchCode: 'BR1',
    soundbox: true,
    standeeCount: 0,
    stickerCount: 0,
    poolStatus: 'POOLED',
    dispatchState: null,
    shipToSuperseded: false,
    dispatchGroup: 'SOUNDBOX',
    batch: null,
    createdAt: '2026-08-08T09:00:00.000Z',
    tenantId: 'tnnt_1',
    programId: 'prg_1',
    ...over,
  }
}

const POOL = [poolRow('asgn_1'), poolRow('asgn_2', { asgnId: 'asgn_2' })]

const CONFIGS = [
  {
    id: 'cfg_global',
    scope: 'GLOBAL',
    tenantWire: null,
    programWire: null,
    minLotSize: 20,
    maxWaitSeconds: 604800,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'cfg_pool',
    scope: 'TENANT_PROGRAM',
    tenantWire: 'tnnt_1',
    programWire: 'prg_1',
    minLotSize: 6,
    maxWaitSeconds: 3600,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
]

function batchRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    triggerReason: 'LOT_SIZE',
    unitCount: 1234,
    printVndr: 'vndr_1',
    triggeredByActor: null,
    triggerNote: null,
    createdAt: '2026-08-10T09:00:00.000Z',
    updatedAt: '2026-08-10T09:00:00.000Z',
    ...over,
  }
}

const BATCHES = [batchRow('btch_aaa'), batchRow('btch_bbb', { unitCount: 7 })]

function batchDetail(artifacts: { asgnId: string; artifactType: string; assetReference: string; supersededAt: string | null }[] = []) {
  return {
    batch: batchRow('btch_aaa'),
    entries: [
      {
        asgnId: 'asgn_1',
        merchantDisplayName: 'Kirana Corner',
        merchantLegalName: 'KIRANA CORNER PRIVATE LIMITED',
        bankReferenceCode: 'GSCB001',
        bankDisplayName: 'GSCB',
        branchCode: 'BR1',
        soundbox: true,
        standeeCount: 0,
        stickerCount: 0,
        poolStatus: 'BATCHED',
        dispatchState: 'SENT_TO_VENDOR',
        shipToSuperseded: false,
        dispatchGroup: 'SOUNDBOX',
      },
    ],
    artifacts,
    printLayout: 'ONE_PER_PAGE',
  }
}

const ARTIFACT = { asgnId: 'asgn_1', artifactType: 'SOUNDBOX_IMG', assetReference: 'asset_1', supersededAt: null }

function journey(over: Record<string, unknown> = {}) {
  return {
    batchId: 'btch_aaa',
    counts: { total: 2, sentToVendor: 2, dispatched: 0, delivered: 0, activated: 0 },
    courier: { pickedUp: 0, inTransit: 0, outForDelivery: 0, delivered: 0, exception: 0 },
    activation: { awaiting: 0, activated: 0, failed: 0, simActivated: null },
    awaitingActivation: [],
    watermark: { asOf: '2026-08-11T09:00:00.000Z', perTopic: {} },
    ...over,
  }
}

const PREVIEW = {
  rows: [
    {
      rowNo: 1,
      valid: true,
      errors: [],
      row: {
        fileId: 'file-1',
        rowNo: 1,
        bankMerchantReference: 'BMR-1',
        displayName: 'Acme Store',
        legalName: 'ACME PVT LTD',
        mcc: '5411',
        registeredAddress: '1 Market St',
        bankReferenceCode: 'GSCB001',
        productType: 'SOUNDBOX',
        vpaValue: 'acme@bank',
        qrValue: 'qr-1',
        soundbox: true,
        standeeCount: 0,
        stickerCount: 0,
        shipToAddress: '2 Ship Ln',
        contactName: 'Jane Doe',
        mobile: '9990000001',
        branchCode: 'BR1',
      },
    },
  ],
  summary: { total: 1, valid: 1, invalid: 0 },
  structuralErrors: [],
}

const COMMIT = {
  accepted: 1,
  quarantined: 0,
  duplicate: 0,
  qrMalformed: 0,
  duplicateVpa: 0,
  duplicateVpaHeld: [],
  duplicateMobile: 0,
  fileId: 'file-1',
}

interface StubOptions {
  /** POOLED rows. Mutated by a bank commit, so the pool read after a commit differs. */
  pool?: unknown
  batches?: unknown
  detail?: unknown
  /** `404` makes the journey read 404, the analytics-projection-has-no-rows case. */
  journeyBody?: unknown | 404
  artifacts?: { asgnId: string; artifactType: string; assetReference: string; supersededAt: string | null }[]
  preview?: unknown
  /** What the pool read returns AFTER a successful commit. Defaults to POOL. */
  poolAfterCommit?: unknown
  /**
   * How many pool reads after the commit still answer with the OLD pool. This is
   * the REAL system's shape: a commit writes fct.tms.bank_file_row.v1 to the TMS
   * outbox, and the records are pooled only once the relay has published it and
   * the fulfillment consumer has folded it, so the read the commit itself makes
   * has not caught up yet. Defaults to 0, the synchronous case.
   */
  poolLagReads?: number
  /** What POST /ops/batches/trigger answers. `null` is the edge's "nothing eligible". */
  trigger?: unknown
}

function stub(opts: StubOptions = {}): Call[] {
  const calls: Call[] = []
  const poolBefore = opts.pool ?? POOL
  let committed = false
  let poolReadsSinceCommit = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({ url, init })
      // Ordered longest-prefix first: /ops/batches/trigger and
      // /ops/batches/<id> both contain the /ops/batches list path.
      if (url.includes('/ops/batches/trigger')) {
        // hasOwnProperty, not `??`: `trigger: null` is a MEANINGFUL body (the
        // edge's "nothing was eligible"), and nullish coalescing would silently
        // replace it with the default.
        return jsonResponse(Object.prototype.hasOwnProperty.call(opts, 'trigger') ? opts.trigger : { btchId: 'btch_new' })
      }
      if (url.includes('/ops/uploads/bank/preview')) return jsonResponse(opts.preview ?? PREVIEW)
      if (url.includes('/ops/uploads/bank/commit')) {
        committed = true
        poolReadsSinceCommit = 0
        return jsonResponse(COMMIT)
      }
      if (url.includes('/ops/reports/batch-journey/')) {
        if (opts.journeyBody === 404) return jsonResponse({ message: 'not found' }, 404)
        return jsonResponse(opts.journeyBody ?? journey())
      }
      if (url.includes('/ops/batching-config')) return jsonResponse(CONFIGS)
      if (/\/ops\/batches\/btch_/.test(url)) return jsonResponse(opts.detail ?? batchDetail(opts.artifacts))
      if (url.includes('/ops/batches')) return jsonResponse(opts.batches ?? BATCHES)
      if (url.includes('/ops/pool')) {
        if (!committed) return jsonResponse(poolBefore)
        poolReadsSinceCommit += 1
        // The first `poolLagReads` reads after the commit have not caught up yet.
        if (poolReadsSinceCommit <= (opts.poolLagReads ?? 0)) return jsonResponse(poolBefore)
        return jsonResponse(opts.poolAfterCommit ?? POOL)
      }
      // Everything else (the three Needs-you counts, BatchablePools' device
      // stock read) gets a harmless empty list.
      return jsonResponse([])
    }),
  )
  return calls
}

function renderAt(path: string, pollIntervals?: { fast: number; slow: number }) {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route
            path="/workflow/*"
            element={pollIntervals === undefined ? <WorkflowPage /> : <WorkflowPage pollIntervals={pollIntervals} />}
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

function journeyCalls(calls: Call[]): number {
  return calls.filter((c) => c.url.includes('/ops/reports/batch-journey/')).length
}

// Which stage the rail says is CURRENT. Read off aria-current rather than by
// matching stage prose, because the stage bodies and the helper cards
// deliberately share their wording (one module owns every string), so a text
// match finds two elements and proves neither.
async function currentStage(): Promise<string> {
  const rail = await screen.findByRole('navigation', { name: /workflow stages/i })
  const current = rail.querySelector('[aria-current="step"]')
  return current?.textContent ?? ''
}

describe('WorkflowPage: the landing view', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('renders an h1 reading Workflow, which portal-smoke requires', async () => {
    stub()
    renderAt('/workflow')
    expect(await screen.findByRole('heading', { name: /^workflow$/i })).toBeTruthy()
  })

  it('the landing view lists each pool with its ready count, lot size and oldest age', async () => {
    stub()
    renderAt('/workflow')
    // Two POOLED rows in one (tenant, program) pool, whose TENANT_PROGRAM
    // batching config sets the lot size to 6.
    expect(await screen.findByText(/2 of 6 ready/i)).toBeTruthy()
    expect(screen.getByText(/oldest/i)).toBeTruthy()
  })

  // NOT "with the stage it is on": GET /ops/batches carries no stage and no
  // status (the fulfillment BatchRow DTO has neither), and the only honest
  // per-batch stage comes from the journey read, one call per batch. So the
  // list links to where the stage IS derived rather than guessing at it here.
  it('the landing view lists every in-flight batch and links each to its own rail, claiming no stage', async () => {
    stub()
    renderAt('/workflow')
    const link = await screen.findByRole('link', { name: /btch_aaa/i })
    expect(link.getAttribute('href')).toBe('/workflow/btch_aaa')
    expect(screen.getByRole('link', { name: /btch_bbb/i })).toBeTruthy()
    // 1,234 through fmtNumber, not a bare 1234.
    expect(screen.getByText(/1,234/)).toBeTruthy()
  })

  it('selecting a batch moves to /workflow/:btchId and renders its rail', async () => {
    stub({ artifacts: [ARTIFACT] })
    renderAt('/workflow')
    await userEvent.click(await screen.findByRole('link', { name: /btch_aaa/i }))
    expect(await screen.findByRole('navigation', { name: /workflow stages/i })).toBeTruthy()
    // Batch mode, not the landing view: the way back appears and the two live
    // regions are gone.
    expect(screen.getByRole('link', { name: /everything in flight/i })).toBeTruthy()
    expect(screen.queryByText(/waiting to be batched/i)).toBeNull()
  })
})

describe('WorkflowPage: batch mode', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  // Honesty rule 1: a batch cannot be traced back to the files that fed it,
  // because pending_pool_entry holds no file_id. So stages 1 and 2 carry the
  // checkmark and NO file detail, and above all no drop zone: a bank file picked
  // while looking at a batch would have nothing to do with that batch.
  it('the rail marks Upload and Validate complete on a batch, and claims no file detail', async () => {
    stub({ artifacts: [ARTIFACT] })
    renderAt('/workflow/btch_aaa')
    const rail = await screen.findByRole('navigation', { name: /workflow stages/i })
    // A completed pill is a button (the rail makes only completed stages
    // clickable), so Upload and Validate being buttons IS the completion claim.
    expect(rail.querySelectorAll('button').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByLabelText(/bank request file/i)).toBeNull()
  })

  it('a 404 on the journey read does not blank the page: the earlier stages still render', async () => {
    stub({ artifacts: [ARTIFACT], journeyBody: 404 })
    renderAt('/workflow/btch_aaa')
    // Generate is complete (one artifact), so Print is current and renders. A
    // 404 is "the projection has no rows for this batch yet", not a failure.
    expect(await screen.findByText(/available to the print vendor/i)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not render the pool body for one tick before the batch read lands', async () => {
    stub({ artifacts: [ARTIFACT] })
    renderAt('/workflow/btch_aaa')
    // BatchStage infers pool mode from batchDetail === null, its only signal, so
    // the page must render nothing rather than hand it a null it would misread.
    expect(screen.queryByText(/ready to batch/i)).toBeNull()
    await screen.findByRole('navigation', { name: /workflow stages/i })
    expect(screen.queryByText(/ready to batch/i)).toBeNull()
  })
})

describe('WorkflowPage: the bank upload, restored', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  // The six transport assertions T6 orphaned. Nothing in the portal suite
  // asserted any of them once BankUploadPage was deleted, and this page is what
  // makes them true again.
  it('POSTs the picked file as multipart FormData with a Bearer header, and no Idempotency-Key on preview', async () => {
    const calls = stub()
    renderAt('/workflow')
    const input = await screen.findByLabelText(/bank request file/i)
    await userEvent.upload(input, makeFile('the server parses this'))

    expect(await screen.findByText(/1 row\(s\) previewed/i)).toBeTruthy()
    const previewCall = calls.find((c) => c.url.includes('/ops/uploads/bank/preview'))
    expect(previewCall).toBeTruthy()
    expect(headerValue(previewCall!, 'Authorization')).toBe('Bearer tok-1')
    // A preview writes nothing, so it is a pure read and carries no key.
    expect(headerValue(previewCall!, 'Idempotency-Key')).toBeNull()
    expect(previewCall!.init.body).toBeInstanceOf(FormData)
    expect(await readFormFileText(previewCall!.init.body as FormData)).toBe('the server parses this')
  })

  it('commits the same file bytes with a fresh Idempotency-Key, exactly once per click', async () => {
    const calls = stub({ poolAfterCommit: [...POOL, poolRow('asgn_3', { asgnId: 'asgn_3' })] })
    renderAt('/workflow')
    await userEvent.upload(await screen.findByLabelText(/bank request file/i), makeFile('the server parses this'))
    await userEvent.click(await screen.findByRole('button', { name: /commit bank request file/i }))

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/uploads/bank/commit'))).toBe(true)
    })
    const commitCalls = calls.filter((c) => c.url.includes('/ops/uploads/bank/commit'))
    // ONE request per click, not two: the client's internal refresh retry reuses
    // the same key rather than minting a second write.
    expect(commitCalls.length).toBe(1)
    const commit = commitCalls[0]!
    expect(headerValue(commit, 'Authorization')).toBe('Bearer tok-1')
    expect(headerValue(commit, 'Idempotency-Key')).toBeTruthy()
    expect(commit.init.body).toBeInstanceOf(FormData)
    // The SAME bytes preview saw, so the operator commits what they reviewed.
    expect(await readFormFileText(commit.init.body as FormData)).toBe('the server parses this')
  })

  it('rejects a file over 5 MB client-side and never posts it at all', async () => {
    const calls = stub()
    renderAt('/workflow')
    await userEvent.upload(await screen.findByLabelText(/bank request file/i), makeOversizedFile())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/5 MB/)
    // "MB", never "MiB": the repo-wide sweep at 98fc943.
    expect(alert.textContent).not.toMatch(/MiB/)
    // The cap runs BEFORE any network call, so no bank route is touched at all.
    expect(calls.some((c) => c.url.includes('/ops/uploads/bank'))).toBe(false)
  })

  it('a committed bank file advances the rail to Batch with no navigation', async () => {
    // The pool GAINS a row on commit, which is what the page waits for: the rail
    // moves only after a read confirms the pool changed, never on the commit
    // response alone.
    stub({ poolAfterCommit: [...POOL, poolRow('asgn_3', { asgnId: 'asgn_3' })] })
    renderAt('/workflow')
    await userEvent.upload(await screen.findByLabelText(/bank request file/i), makeFile('rows'))
    await userEvent.click(await screen.findByRole('button', { name: /commit bank request file/i }))
    // BatchStage's pool body, which is stage 3.
    expect(await screen.findByText(/ready to batch/i)).toBeTruthy()
    // Still the same url: the whole flow is one screen.
    expect(screen.getByRole('heading', { name: /^workflow$/i })).toBeTruthy()
  })

  // THE REAL SYSTEM'S SHAPE, and the case a synchronous stub hides completely.
  // A commit writes fct.tms.bank_file_row.v1 to the TMS outbox; the records are
  // pooled only once the relay publishes it and the fulfillment consumer folds
  // it. So the pool read the commit itself makes has NOT caught up, and if the
  // page only compared there, the rail would never advance in production while
  // every test passed. Confirmed against the running harness: after a real
  // commit, GET /ops/pool still answered with zero rows and the facts sat
  // unpublished in tms.outbox.
  //
  // ONE ASSERTION ON PURPOSE. An earlier version of this test also asserted that
  // the commit counts were on screen first, and it was flaky one run in five in
  // BOTH directions: the two assertions race each other, because whether the
  // confirming read is the commit's own or the next poll's depends on which
  // in-flight pool read the stub's lag counter happens to serve. The half that
  // was actually broken is that the rail advances AT ALL once a later read sees
  // the pool, and the other half ("a commit alone never advances it") is pinned
  // deterministically by the next test, where the pool never changes.
  it('advances the rail on a LATER read, when the pool has caught up, not on the commit', async () => {
    stub({
      pool: [],
      poolAfterCommit: POOL,
      // The commit's own read still shows the empty pool. Only a later one, a
      // poll, sees the records.
      poolLagReads: 1,
    })
    // Pool mode is always the SLOW cadence, so that is the interval to shrink.
    // Not to single digits: a 10ms poll issues two reads per tick and buries the
    // DOM queries under its own re-renders.
    renderAt('/workflow', { fast: 5000, slow: 40 })
    await userEvent.upload(await screen.findByLabelText(/bank request file/i), makeFile('rows'))
    await userEvent.click(await screen.findByRole('button', { name: /commit bank request file/i }))

    // The rail follows the system rather than the click.
    await waitFor(
      () => {
        expect(screen.queryByText(/ready to batch/i)).toBeTruthy()
      },
      { timeout: 3000 },
    )
  })

  it('does NOT advance the rail when the commit changed nothing in the pool', async () => {
    // Every row quarantined: the commit answered, but nothing was pooled, so the
    // rail must stay where it is rather than claim a batch stage that has no
    // records behind it.
    stub({ poolAfterCommit: POOL })
    renderAt('/workflow')
    await userEvent.upload(await screen.findByLabelText(/bank request file/i), makeFile('rows'))
    await userEvent.click(await screen.findByRole('button', { name: /commit bank request file/i }))
    // The commit counts render on the Validate stage. An EXACT match: the
    // Validate stage's own helper copy also contains the word "accepted".
    expect(await screen.findByText('Accepted')).toBeTruthy()
    expect(screen.queryByText(/ready to batch/i)).toBeNull()
  })

  // Carried finding 2: a whole-file rejection keeps the reasons AND the file
  // picker on one screen. Advancing to Validate would render the reasons beside
  // no picker at all, which is a dead end the old page did not have.
  it('keeps a structurally rejected file on Upload, with the reasons beside the picker', async () => {
    stub({
      preview: {
        rows: [],
        summary: { total: 0, valid: 0, invalid: 0 },
        structuralErrors: [{ code: 'missing_required_column', message: 'Missing column: Mobile' }],
      },
    })
    renderAt('/workflow')
    await userEvent.upload(await screen.findByLabelText(/bank request file/i), makeFile('bad header'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/missing column: mobile/i)
    // The picker is still there, so a different file can be tried without
    // navigating anywhere.
    expect(screen.getByLabelText(/bank request file/i)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('a trigger returning null says nothing was eligible rather than spinning', async () => {
    stub({ poolAfterCommit: [...POOL, poolRow('asgn_3', { asgnId: 'asgn_3' })], trigger: null })
    renderAt('/workflow')
    await userEvent.upload(await screen.findByLabelText(/bank request file/i), makeFile('rows'))
    await userEvent.click(await screen.findByRole('button', { name: /commit bank request file/i }))
    await screen.findByText(/ready to batch/i)

    // BatchablePools requires a reason before it will let the trigger fire.
    await userEvent.type(screen.getAllByLabelText(/reason/i)[0]!, 'batching early for the pilot')
    await userEvent.click(screen.getByRole('button', { name: /trigger batch/i }))
    expect(await screen.findByText(/nothing to batch/i)).toBeTruthy()
  })
})

describe('WorkflowPage: the adaptive poll', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => {
    cleanup()
    // visibilityState is defined on the shared document and survives cleanup(),
    // so every test after a hidden one would start with polling switched off.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('polls FAST while Generate is waiting on the machine', async () => {
    // No artifacts: Generate is current, and composition is the machine working.
    const calls = stub({ artifacts: [] })
    renderAt('/workflow/btch_aaa', { fast: 10, slow: 5000 })
    await screen.findByText(/composing the package/i)
    await vi.waitFor(() => {
      expect(journeyCalls(calls)).toBeGreaterThan(2)
    })
  })

  it('polls SLOW on a stage that waits on a human', async () => {
    // Everything delivered, nothing activated: Activation is current, and a
    // person marks records activated one at a time. `fast` is set to 5000 so a
    // page that mistakenly polled fast would make NO extra calls in this window.
    const calls = stub({
      artifacts: [ARTIFACT],
      journeyBody: journey({
        counts: { total: 2, sentToVendor: 2, dispatched: 2, delivered: 2, activated: 0 },
        courier: { pickedUp: 0, inTransit: 0, outForDelivery: 0, delivered: 2, exception: 0 },
        activation: { awaiting: 2, activated: 0, failed: 0, simActivated: null },
      }),
    })
    renderAt('/workflow/btch_aaa', { fast: 5000, slow: 10 })
    await waitFor(async () => {
      expect(await currentStage()).toMatch(/activation/i)
    })
    await vi.waitFor(() => {
      expect(journeyCalls(calls)).toBeGreaterThan(2)
    })
  })

  it('STOPS polling when the tab is hidden', async () => {
    const calls = stub({ artifacts: [] })
    renderAt('/workflow/btch_aaa', { fast: 10, slow: 5000 })
    await screen.findByText(/composing the package/i)
    await vi.waitFor(() => {
      expect(journeyCalls(calls)).toBeGreaterThan(2)
    })

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    // Let the interval teardown and any in-flight read settle INSIDE act, so a
    // late setState is not mistaken for a poll that kept running.
    await act(async () => { await new Promise((r) => { setTimeout(r, 40) }) })

    const settled = journeyCalls(calls)
    await act(async () => { await new Promise((r) => { setTimeout(r, 120) }) })
    expect(journeyCalls(calls)).toBe(settled)
  })

  it('STOPS polling once every record is activated', async () => {
    const calls = stub({
      artifacts: [ARTIFACT],
      journeyBody: journey({
        counts: { total: 2, sentToVendor: 2, dispatched: 2, delivered: 2, activated: 2 },
        courier: { pickedUp: 0, inTransit: 0, outForDelivery: 0, delivered: 2, exception: 0 },
        activation: { awaiting: 0, activated: 2, failed: 0, simActivated: null },
      }),
    })
    renderAt('/workflow/btch_aaa', { fast: 10, slow: 10 })
    await waitFor(async () => {
      expect(await currentStage()).toMatch(/activation/i)
    })
    await act(async () => { await new Promise((r) => { setTimeout(r, 60) }) })

    const settled = journeyCalls(calls)
    await act(async () => { await new Promise((r) => { setTimeout(r, 120) }) })
    // Nothing is left to watch, so there is nothing to poll for.
    expect(journeyCalls(calls)).toBe(settled)
  })
})
