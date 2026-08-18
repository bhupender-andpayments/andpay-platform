import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useParams } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { ActivationPage } from '../../src/features/activation/ActivationPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// REWRITTEN 18 Aug 2026, at the user's correction, alongside the page. The
// page went from a two-card design (a batches summary above a per-dispatch
// worklist, each with its own action buttons) to ONE table, batch-grain only:
//   - "Mark sent to CWD" is gone entirely (it recorded REQUEST_SENT_TO_CWD,
//     an in-flight marker with no observable effect, which read as doing
//     nothing).
//   - The per-dispatch worklist, its checkboxes and its own "Mark activated"
//     button are gone. A batch's devices are activated together.
//   - Activate calls POST /ops/assignments/activate-bulk with the batch's own
//     dispatch ids, independent of delivery and courier status (D-16), and
//     the batch leaves the table once it returns.
//   - Download Excel is renamed Download CWD file; the route is unchanged
//     (GET /ops/reports/activation/batch/:btchId/xlsx).

interface Call {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function parseBody(call: Call): Record<string, unknown> {
  return call.init.body === undefined ? {} : (JSON.parse(call.init.body as string) as Record<string, unknown>)
}

function headerValue(call: Call, name: string): string | null {
  const headers = call.init.headers as Record<string, string>
  return headers[name] ?? null
}

function DevicesPageStub() {
  const { btchId } = useParams<{ btchId: string }>()
  return <div>DEVICES PAGE for {btchId}</div>
}

function renderActivationPage() {
  return render(
    <MemoryRouter initialEntries={['/activation']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/activation" element={<ActivationPage />} />
          <Route path="/activation/batch/:btchId" element={<DevicesPageStub />} />
          <Route path="/inventory" element={<div>INVENTORY PAGE</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

// btch_alpha: TWO dispatches and THREE devices, deliberately different
// numbers. The sheet carries one row per DEVICE, so a table that counted
// dispatches and called them devices would understate what the CWD receives.
const BATCH_ROWS = {
  rows: [
    {
      dispatchId: 'asgn_1',
      programId: 'prg_1',
      batchId: 'btch_alpha',
      bankCode: 'HDFC',
      bankDisplay: 'HDFC Bank',
      merchantDisplay: 'Alpha Store',
      deviceIds: ['DEV-1', 'DEV-2'],
      deliveryDate: null,
      activationStatus: null,
      // D15: a batch shows on the table only once every one of its dispatches
      // has been dispatched by vendor. These fixture rows are already there.
      pipelineState: 'DISPATCHED',
    },
    {
      dispatchId: 'asgn_2',
      programId: 'prg_1',
      batchId: 'btch_alpha',
      bankCode: 'HDFC',
      bankDisplay: 'HDFC Bank',
      merchantDisplay: 'Beta Store',
      deviceIds: ['DEV-3'],
      deliveryDate: null,
      activationStatus: null,
      pipelineState: 'DISPATCHED',
    },
    {
      dispatchId: 'asgn_3',
      programId: 'prg_1',
      batchId: 'btch_beta',
      bankCode: 'ICIC',
      bankDisplay: 'ICICI Bank',
      merchantDisplay: 'Gamma Store',
      deviceIds: ['DEV-4'],
      deliveryDate: null,
      activationStatus: null,
      pipelineState: 'DISPATCHED',
    },
    {
      dispatchId: 'asgn_legacy',
      programId: 'prg_1',
      batchId: null,
      bankCode: 'HDFC',
      bankDisplay: 'HDFC Bank',
      merchantDisplay: 'Legacy Store',
      deviceIds: ['DEV-5'],
      deliveryDate: null,
      activationStatus: null,
      pipelineState: 'DISPATCHED',
    },
  ],
  watermark: { asOf: null, perTopic: {} },
}

// The xlsx route's response, faked as a plain object rather than a real
// `Response`: the body is OPAQUE CARGO and the portal must hand it straight
// to the browser, so `text`/`arrayBuffer` are spies that must never be called.
function xlsxResponse(filename: string | null, blob: unknown, status = 200): unknown {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-disposition' && filename !== null
          ? `attachment; filename="${filename}"`
          : null,
    },
    blob: async () => blob,
    text: async () => '',
  }
}

// jsdom has no Blob-URL implementation to spy on, so createObjectURL and
// revokeObjectURL are defined directly, and document.createElement('a') is
// wrapped so `.click()` is a spy instead of a real navigation.
function captureSaveBlob(): { objectUrlArgs: unknown[]; anchors: HTMLAnchorElement[] } {
  const objectUrlArgs: unknown[] = []
  Object.defineProperty(URL, 'createObjectURL', {
    value: (blob: unknown) => {
      objectUrlArgs.push(blob)
      return 'blob:mock-url'
    },
    writable: true,
    configurable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true, configurable: true })

  const anchors: HTMLAnchorElement[] = []
  const realCreateElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = realCreateElement(tag)
    if (tag === 'a') {
      ;(el as HTMLAnchorElement).click = vi.fn()
      anchors.push(el as HTMLAnchorElement)
    }
    return el
  }) as typeof document.createElement)
  return { objectUrlArgs, anchors }
}

// The batch row that owns a given batch id, found by its DataGrid cell text.
function batchRowFor(batchId: string): HTMLElement {
  return screen.getByText(batchId).closest('tr')!
}

async function confirmActivateInDialog(): Promise<void> {
  const dialog = await screen.findByRole('dialog')
  await userEvent.click(within(dialog).getByRole('button', { name: /^activate$/i }))
}

function stubBatches(handler?: (url: string, init: RequestInit) => unknown): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const handled = handler?.(url, init)
      if (handled !== undefined) return handled
      return jsonResponse(BATCH_ROWS)
    }),
  )
  return calls
}

describe('ActivationPage', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    // The createElement spy would otherwise outlive its test.
    vi.restoreAllMocks()
  })

  // THREE COLUMNS as of 18 Aug 2026: Batch, Bank NAME, Soundboxes. The
  // dispatch count is deliberately not a column any more (a batch's collateral
  // legs inflate it without adding anything the CWD activates), and the bank is
  // its name off the report row rather than a raw code.
  it('shows one row per batch with the bank NAME and the SOUNDBOX count, not the dispatch count', async () => {
    stubBatches()
    renderActivationPage()

    expect(await screen.findByText('Batches ready for activation')).toBeTruthy()

    const alpha = batchRowFor('btch_alpha')
    expect(within(alpha).getByText('HDFC Bank')).toBeTruthy()
    // THREE devices from TWO dispatches: the sheet has one row per device, so
    // 3 is the number shown and 2 must not appear as a count column.
    expect(within(alpha).getByText('3')).toBeTruthy()
    expect(within(alpha).queryByText('2')).toBeNull()

    const beta = batchRowFor('btch_beta')
    expect(within(beta).getByText('ICICI Bank')).toBeTruthy()
    expect(within(beta).getByText('1')).toBeTruthy()
  })

  // 16 Aug 2026 UAT, still true under the batch table: a dispatch with no
  // device paired contributes nothing to activate, so it must not inflate a
  // batch's counts or appear as its own group.
  it('excludes a dispatch with no device paired from every batch it would otherwise join', async () => {
    stubBatches((url) =>
      url.includes('/ops/reports/activation')
        ? jsonResponse({
            rows: [
              { ...BATCH_ROWS.rows[0]!, deviceIds: [] },
              { ...BATCH_ROWS.rows[1]! },
            ],
            watermark: { asOf: null, perTopic: {} },
          })
        : undefined,
    )
    renderActivationPage()

    await screen.findByText('Batches ready for activation')
    const alpha = batchRowFor('btch_alpha')
    // Only asgn_2 counted: 1 soundbox. asgn_1's TWO device ids are excluded
    // entirely because it has no device paired, so a count of 3 here would be
    // the bug this pins.
    expect(within(alpha).getByText('1')).toBeTruthy()
    expect(within(alpha).queryByText('3')).toBeNull()
  })

  it('clicking a batch row opens its devices page, not the dispatch-grain batch page (decision D8)', async () => {
    stubBatches()
    renderActivationPage()

    await screen.findByText('Batches ready for activation')
    await userEvent.click(batchRowFor('btch_alpha'))

    expect(await screen.findByText('DEVICES PAGE for btch_alpha')).toBeTruthy()
  })

  it('keeps a not-yet-dispatched batch OFF the table, and says so (decision D15)', async () => {
    stubBatches((url) =>
      url.includes('/ops/reports/activation')
        ? jsonResponse({
            rows: [{ ...BATCH_ROWS.rows[0]!, batchId: 'btch_pending', pipelineState: 'SENT_TO_VENDOR' }],
            watermark: { asOf: null, perTopic: {} },
          })
        : undefined,
    )
    renderActivationPage()

    expect(await screen.findByText(/still with the print vendor, not yet dispatched/i)).toBeTruthy()
    expect(screen.queryByText('btch_pending')).toBeNull()
  })

  it('downloads the batch xlsx from the batch route and saves it under the SERVED filename, without ever reading the bytes', async () => {
    const textSpy = vi.fn(async () => '')
    const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(0))
    const fakeBlob = { text: textSpy, arrayBuffer: arrayBufferSpy }
    const calls = stubBatches((url) =>
      url.includes('/xlsx') ? xlsxResponse('btch_alpha-activation.xlsx', fakeBlob) : undefined,
    )
    const { objectUrlArgs, anchors } = captureSaveBlob()

    renderActivationPage()
    await screen.findByText('Batches ready for activation')
    await userEvent.click(within(batchRowFor('btch_alpha')).getByRole('button', { name: /download cwd file/i }))

    const download = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/xlsx'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(download.url).toContain('/ops/reports/activation/batch/btch_alpha/xlsx')

    await vi.waitFor(() => {
      expect(anchors.some((a) => a.download === 'btch_alpha-activation.xlsx')).toBe(true)
    })
    expect(objectUrlArgs).toContain(fakeBlob)
    expect(textSpy).not.toHaveBeenCalled()
    expect(arrayBufferSpy).not.toHaveBeenCalled()
  })

  it('renders a plain sentence, not a thrown error, when the batch route answers 404', async () => {
    stubBatches((url) => (url.includes('/xlsx') ? xlsxResponse(null, { text: vi.fn(), arrayBuffer: vi.fn() }, 404) : undefined))
    captureSaveBlob()

    renderActivationPage()
    await screen.findByText('Batches ready for activation')
    await userEvent.click(within(batchRowFor('btch_alpha')).getByRole('button', { name: /download cwd file/i }))

    expect(await screen.findByText(/nothing awaiting activation/i)).toBeTruthy()
    // The other batch is untouched: one batch's 404 is not the table's verdict.
    expect(within(batchRowFor('btch_beta')).queryByText(/nothing awaiting activation/i)).toBeNull()
  })

  // THE CORE OF THE REDESIGN. Activate calls the bulk route with the batch's
  // own dispatch ids, independent of delivery and courier status (D-16): it
  // does not touch any dispatch or shipment endpoint at all.
  it('activating a batch opens the confirmation and posts only the batch dispatch ids after it is confirmed', async () => {
    const calls = stubBatches((url) =>
      url.includes('/activate-bulk')
        ? jsonResponse({
            results: [
              { dispatchId: 'asgn_1', activated: true, reason: null },
              { dispatchId: 'asgn_2', activated: true, reason: null },
            ],
          })
        : undefined,
    )

    renderActivationPage()
    await screen.findByText('Batches ready for activation')
    await userEvent.click(within(batchRowFor('btch_alpha')).getByRole('button', { name: /activate the devices in btch_alpha/i }))

    // The first click only asks. Nothing has been written.
    expect(calls.some((c) => c.url.includes('/activate-bulk'))).toBe(false)
    await confirmActivateInDialog()

    const write = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/activate-bulk'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(write.init.method).toBe('POST')
    // btch_beta's dispatch id is not in this batch's send.
    expect(parseBody(write).dispatchIds).toEqual(['asgn_1', 'asgn_2'])
    expect(headerValue(write, 'Idempotency-Key')).toBeTruthy()
  })

  it('reports what ACTUALLY activated in the success dialog, never what was asked for', async () => {
    stubBatches((url) =>
      url.includes('/activate-bulk')
        ? jsonResponse({
            results: [
              { dispatchId: 'asgn_1', activated: true, reason: null },
              { dispatchId: 'asgn_2', activated: false, reason: 'already-activated' },
            ],
          })
        : undefined,
    )

    renderActivationPage()
    await screen.findByText('Batches ready for activation')
    await userEvent.click(within(batchRowFor('btch_alpha')).getByRole('button', { name: /activate the devices in btch_alpha/i }))
    await confirmActivateInDialog()

    // Two were sent; only one actually activated. Saying "2" would be the
    // exact false claim the old bulk-outcome test existed to block.
    expect(await screen.findByText(/1 device activated/i)).toBeTruthy()
    expect(screen.queryByText(/2 devices activated/i)).toBeNull()
  })

  it('removes an activated batch from the table, and the success dialog can jump to Inventory', async () => {
    stubBatches((url) =>
      url.includes('/activate-bulk')
        ? jsonResponse({ results: [{ dispatchId: 'asgn_1', activated: true, reason: null }, { dispatchId: 'asgn_2', activated: true, reason: null }] })
        : undefined,
    )

    renderActivationPage()
    await screen.findByText('Batches ready for activation')
    await userEvent.click(within(batchRowFor('btch_alpha')).getByRole('button', { name: /activate the devices in btch_alpha/i }))
    await confirmActivateInDialog()

    expect(await screen.findByText(/2 devices activated/i)).toBeTruthy()
    // btch_alpha is gone from behind the dialog; btch_beta is untouched.
    expect(screen.queryByText('btch_alpha')).toBeNull()
    expect(screen.getByText('btch_beta')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /view inventory/i }))
    expect(await screen.findByText('INVENTORY PAGE')).toBeTruthy()
  })

  // A legacy pre-batch row cannot download (nothing to name the sheet after)
  // but can still be activated: markActivatedBulk needs only dispatch ids.
  it('lets a batchless legacy group activate, with no download offered', async () => {
    stubBatches()
    renderActivationPage()

    await screen.findByText('Batches ready for activation')
    const legacy = screen.getByText('No batch').closest('tr')!
    expect(within(legacy).queryByRole('button', { name: /download cwd file/i })).toBeNull()
    expect(within(legacy).getByRole('button', { name: /activate/i })).toBeTruthy()
  })

  it('shows the number of banks rather than picking one when a batch spans several', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          rows: [
            { ...BATCH_ROWS.rows[0]!, batchId: 'btch_mixed', bankDisplay: 'HDFC Bank' },
            { ...BATCH_ROWS.rows[1]!, batchId: 'btch_mixed', bankDisplay: 'ICICI Bank' },
          ],
          watermark: { asOf: null, perTopic: {} },
        }),
      ),
    )
    renderActivationPage()

    await screen.findByText('Batches ready for activation')
    expect(within(batchRowFor('btch_mixed')).getByText('2 banks')).toBeTruthy()
  })

  // ONE FILTER, on the batch id. The old dispatch/merchant/device search box
  // and bank multi-select both filtered by things this table no longer shows.
  it('filters on the batch id only, and offers no other filter control', async () => {
    stubBatches()
    renderActivationPage()

    await screen.findByText('Batches ready for activation')
    expect(screen.getByText('btch_beta')).toBeTruthy()

    await userEvent.type(screen.getByLabelText(/batch id/i), 'alpha')

    await vi.waitFor(() => {
      expect(screen.queryByText('btch_beta')).toBeNull()
    })
    expect(screen.getByText('btch_alpha')).toBeTruthy()
    // No bank picker, and no search box naming columns that do not exist.
    expect(screen.queryByLabelText(/^bank$/i)).toBeNull()
    expect(screen.queryByPlaceholderText(/dispatch, merchant or device/i)).toBeNull()
  })

  it('renders the empty state when nothing is awaiting activation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ rows: [], watermark: { asOf: null, perTopic: {} } })))
    renderActivationPage()

    expect(await screen.findByText(/nothing is awaiting activation/i)).toBeTruthy()
  })

  // THE REMOVED CONTROLS. Neither the per-dispatch worklist nor the
  // request-activation ("Mark sent to CWD") write exists on this page any
  // more; asserting their absence is what would catch either regressing back.
  it('has no per-dispatch worklist, no checkboxes, and no Mark sent to CWD control anywhere', async () => {
    stubBatches()
    renderActivationPage()

    await screen.findByText('Batches ready for activation')
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /mark sent to cwd/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^mark activated$/i })).toBeNull()
    expect(screen.queryByText('Awaiting activation')).toBeNull()
  })
})
