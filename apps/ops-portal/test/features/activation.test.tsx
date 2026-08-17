import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { ActivationPage } from '../../src/features/activation/ActivationPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// FR-07 Phase-1 MANUAL activation SUCCESS mark (Phase 7 Task 11, D-H.1). The
// confirmed ops-edge contract (apps/ops-edge/src/ops.controller.ts's
// activateAssignmentRoute + services/analytics/src/mediation.ts's
// activationRow, docs/plan/phase7_grounding/B_edge_contracts.md row #11):
//   GET  /ops/reports/activation   -> { rows: ReportRow[], watermark }
//     (server-filtered to soundbox-or-legacy rows with activation_status
//     IS NULL: every row awaiting activation. The delivery half of that
//     filter went away with D-16 / T4.2. Row shape copied verbatim from
//     mediation.ts's activationRow, never invented here.)
//   POST /ops/assignments/activate  body { dispatchId } -> { activated }
//     (dispatchId IS the wire asgn id; NOT step-up-gated.)
// C3 fence: SUCCESS path only. No failure-mark control, no distinct
// SIM-activation control (simActivationStatus mirrors activationStatus and
// is read-only text in v1).

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

// Every write now passes through the shared ConfirmDialog: the first click
// opens it, and the write fires only from its confirm button.
async function confirmInDialog(): Promise<void> {
  const dialog = await screen.findByRole('dialog')
  await userEvent.click(within(dialog).getByRole('button', { name: /mark activated/i }))
}

function renderActivationPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <ActivationPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('ActivationPage', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('lists DELIVERED (activation-report) assignments from GET /ops/reports/activation', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return jsonResponse({
          rows: [
            {
              dispatchId: 'asgn_1',
              programId: 'prg_1',
              bankCode: 'HDFC',
              merchantDisplay: 'Acme Traders',
              deviceIds: ['DEV-1'],
              deliveryDate: '2026-08-01T00:00:00.000Z',
              activationStatus: null,
              simActivationStatus: null,
              activationDate: null,
              activationFailureReason: null,
            },
          ],
          watermark: { asOf: '2026-08-05T00:00:00.000Z', perTopic: {} },
        })
      }),
    )

    renderActivationPage()

    expect(await screen.findByText('asgn_1')).toBeTruthy()
    expect(screen.getByText('Acme Traders')).toBeTruthy()
    const call = calls.find((c) => c.url.includes('/ops/reports/activation'))
    expect(call).toBeTruthy()
    expect(call!.init.method).toBe('GET')
  })

  // 16 Aug 2026 UAT: activation is of a device+SIM, so a dispatch the report
  // returns with NO device paired (pre print-vendor return) must not be
  // offered for activation. There is no hardware the CWD could have confirmed.
  it('hides a dispatch with no device paired: nothing exists to activate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          rows: [
            {
              dispatchId: 'asgn_no_device',
              bankCode: 'HDFC',
              merchantDisplay: 'Not Printed Yet Stores',
              deviceIds: [],
              deliveryDate: null,
              activationStatus: null,
              simActivationStatus: null,
              activationDate: null,
              activationFailureReason: null,
            },
            {
              dispatchId: 'asgn_paired',
              bankCode: 'HDFC',
              merchantDisplay: 'Paired Traders',
              deviceIds: ['DEV-7'],
              deliveryDate: null,
              activationStatus: null,
              simActivationStatus: null,
              activationDate: null,
              activationFailureReason: null,
            },
          ],
          watermark: { asOf: null, perTopic: {} },
        }),
      ),
    )

    renderActivationPage()

    // The paired row is the proof the page rendered; the deviceless one is
    // absent, and the count says 1, not 2.
    expect(await screen.findByText('asgn_paired')).toBeTruthy()
    expect(screen.queryByText('asgn_no_device')).toBeNull()
    expect(screen.getByText('1 row')).toBeTruthy()
  })

  it('marking a DELIVERED assignment calls ops:mark-activated (POST /ops/assignments/activate) with the wire asgn id + an Idempotency-Key', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/assignments/activate')) return jsonResponse({ activated: true })
        return jsonResponse({
          rows: [
            {
              dispatchId: 'asgn_delivered',
              bankCode: 'HDFC',
              merchantDisplay: 'Acme Traders',
              deviceIds: ['DEV-1'],
              deliveryDate: '2026-08-01T00:00:00.000Z',
              activationStatus: null,
              simActivationStatus: null,
              activationFailureReason: null,
            },
          ],
          watermark: { asOf: null, perTopic: {} },
        })
      }),
    )

    renderActivationPage()

    const row = (await screen.findByText('asgn_delivered')).closest('tr')!
    const button = within(row).getByRole('button', { name: /mark activated/i })
    expect((button as HTMLButtonElement).disabled).toBe(false)

    await userEvent.click(button)
    // The first click only opens the confirmation; nothing is written yet.
    expect(calls.some((c) => c.url.includes('/ops/assignments/activate'))).toBe(false)
    await confirmInDialog()

    const call = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/ops/assignments/activate'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(call.init.method).toBe('POST')
    const body = parseBody(call)
    expect(body.dispatchId).toBe('asgn_delivered')
    expect(headerValue(call, 'Idempotency-Key')).toBeTruthy()
  })

  // THE RE-PIN (D-16, T4.2). This used to assert the control was disabled,
  // which pinned the delivered-gate as a rule. Activation no longer waits on
  // delivery, so an undelivered row is markable and the cell says plainly that
  // delivery has not happened yet rather than leaving a blank that would read
  // as missing data.
  it('an UNDELIVERED assignment IS markable, and its delivery cell says so rather than sitting blank', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return jsonResponse({
          rows: [
            {
              dispatchId: 'asgn_not_delivered',
              bankCode: 'HDFC',
              merchantDisplay: 'Acme Traders',
              deviceIds: ['DEV-2'],
              deliveryDate: null,
              activationStatus: null,
              simActivationStatus: null,
              activationFailureReason: null,
            },
          ],
          watermark: { asOf: null, perTopic: {} },
        })
      }),
    )

    renderActivationPage()

    const row = (await screen.findByText('asgn_not_delivered')).closest('tr')!
    expect(within(row).getByText(/not yet delivered/i)).toBeTruthy()
    const button = within(row).getByRole('button', { name: /mark activated/i }) as HTMLButtonElement
    expect(button.disabled).toBe(false)

    await userEvent.click(button)
    await confirmInDialog()

    const write = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/ops/assignments/activate'))
      expect(found).toBeTruthy()
      return found
    })
    expect(JSON.parse(String(write!.init.body)).dispatchId).toBe('asgn_not_delivered')
  })

  // D-19 (T5.4): bulk marking, and the shape of the objection it had to answer.
  // The recorded refusal was that a client-side loop failing halfway leaves an
  // operator unable to tell which records went through. So the result is per
  // row, and the confirmation counts what HAPPENED rather than what was asked.
  describe('bulk mark activated', () => {
    const TWO_ROWS = {
      rows: [
        {
          dispatchId: 'asgn_a',
          bankCode: 'HDFC',
          merchantDisplay: 'Alpha Store',
          deviceIds: ['DEV-A'],
          deliveryDate: '2026-08-09T06:30:00.000Z',
          activationStatus: null,
          simActivationStatus: null,
          activationFailureReason: null,
        },
        {
          dispatchId: 'asgn_b',
          bankCode: 'HDFC',
          merchantDisplay: 'Beta Store',
          deviceIds: ['DEV-B'],
          deliveryDate: null,
          activationStatus: null,
          simActivationStatus: null,
          activationFailureReason: null,
        },
      ],
      watermark: { asOf: null, perTopic: {} },
    }

    function stubBulk(results: { dispatchId: string; activated: boolean; reason: string | null }[]): Call[] {
      const calls: Call[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push({ url, init })
          if (url.includes('/ops/assignments/activate-bulk')) return jsonResponse({ results })
          return jsonResponse(TWO_ROWS)
        }),
      )
      return calls
    }

    it('posts only the ticked rows, and nothing at all with none ticked', async () => {
      const calls = stubBulk([{ dispatchId: 'asgn_a', activated: true, reason: null }])
      renderActivationPage()

      const bulkButton = (await screen.findByRole('button', { name: /mark selected activated/i })) as HTMLButtonElement
      expect(bulkButton.disabled).toBe(true)

      await userEvent.click(screen.getByLabelText('Select Alpha Store'))
      // The label counts the selection, so an operator can see what they are
      // about to act on before they act on it.
      await userEvent.click(await screen.findByRole('button', { name: /mark 1 activated/i }))
      // The bulk button also only opens the confirmation.
      expect(calls.some((c) => c.url.includes('/ops/assignments/activate-bulk'))).toBe(false)
      await confirmInDialog()

      const write = await vi.waitFor(() => {
        const found = calls.find((c) => c.url.includes('/ops/assignments/activate-bulk'))
        expect(found).toBeTruthy()
        return found
      })
      expect(parseBody(write!).dispatchIds).toEqual(['asgn_a'])
    })

    it('reports what ACTUALLY happened per row, never what was asked for', async () => {
      stubBulk([
        { dispatchId: 'asgn_a', activated: true, reason: null },
        { dispatchId: 'asgn_b', activated: false, reason: 'not-activatable' },
      ])
      renderActivationPage()

      await userEvent.click(await screen.findByLabelText('Select Alpha Store'))
      await userEvent.click(screen.getByLabelText('Select Beta Store'))
      await userEvent.click(screen.getByRole('button', { name: /mark 2 activated/i }))
      await confirmInDialog()

      // 1 of 2, not 2. Claiming both is the exact failure the refusal named.
      expect(await screen.findByText(/1 of 2 marked activated/i)).toBeTruthy()
      // And the row that did not go through says why, next to itself, in words
      // rather than in the edge's code vocabulary.
      expect(screen.getByText(/collateral does not activate/i)).toBeTruthy()
    })
  })

  it('has NO failure-mark control and NO distinct SIM-activation control anywhere on the page (C3 fence)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          rows: [
            {
              dispatchId: 'asgn_1',
              bankCode: 'HDFC',
              merchantDisplay: 'Acme Traders',
              deviceIds: ['DEV-1'],
              deliveryDate: '2026-08-01T00:00:00.000Z',
              activationStatus: null,
              simActivationStatus: null,
              activationFailureReason: null,
            },
          ],
          watermark: { asOf: null, perTopic: {} },
        }),
      ),
    )

    renderActivationPage()
    await screen.findByText('asgn_1')

    // No failure-mark button/control of any kind.
    expect(screen.queryByRole('button', { name: /fail/i })).toBeNull()
    // No distinct, editable SIM-activation control (input/select); SIM status
    // is read-only text only.
    expect(screen.queryByRole('button', { name: /sim/i })).toBeNull()
    expect(screen.queryByLabelText(/sim/i)).toBeNull()
    expect(screen.queryAllByRole('combobox').length).toBe(0)
    // Only one write control per row: "Mark activated".
    expect(screen.getAllByRole('button', { name: /mark activated/i })).toHaveLength(1)
  })
})

// The worklist reads the ANALYTICS projection, which the fact rail feeds
// asynchronously, while the activation WRITE lands in TMS. So the re-read that
// already followed a successful mark could legitimately return the row again,
// and did: the operator saw a confirmation and the row they had just actioned
// still sitting there, still offering the button. That is a read-your-own-write
// problem over an eventually consistent view, NOT a missing refetch.
describe('ActivationPage: a row the operator has just actioned', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  function stubWithStaleProjection(): Call[] {
    const calls: Call[] = []
    const row = {
      dispatchId: 'asgn_stale',
      programId: 'prg_1',
      bankCode: 'HDFC',
      merchantDisplay: 'Stale Projection Store',
      deviceIds: ['DEV-9'],
      deliveryDate: '2026-08-01T00:00:00.000Z',
      activationStatus: null,
      simActivationStatus: null,
      activationDate: null,
      activationFailureReason: null,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/assignments/activate')) return jsonResponse({ activated: true })
        // Deliberately ALWAYS returns the row, which is exactly what a
        // projection that has not caught up does.
        return jsonResponse({ rows: [row], watermark: { asOf: null, perTopic: {} } })
      }),
    )
    return calls
  }

  it('leaves the worklist even when the projection still returns it', async () => {
    stubWithStaleProjection()
    renderActivationPage()

    expect(await screen.findByText('Stale Projection Store')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /mark activated/i }))
    await confirmInDialog()

    await vi.waitFor(() => {
      expect(screen.queryByText('Stale Projection Store')).toBeNull()
    })
  })

  it('counts what it is showing, so the header cannot claim a row the table does not have', async () => {
    stubWithStaleProjection()
    renderActivationPage()

    expect(await screen.findByText('Stale Projection Store')).toBeTruthy()
    expect(screen.getByText('1 row')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /mark activated/i }))
    await confirmInDialog()

    await vi.waitFor(() => {
      expect(screen.getByText('0 rows')).toBeTruthy()
    })
  })

  it('names the merchant in the confirmation rather than the wire id', async () => {
    stubWithStaleProjection()
    renderActivationPage()

    expect(await screen.findByText('Stale Projection Store')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /mark activated/i }))
    await confirmInDialog()

    await vi.waitFor(() => {
      expect(screen.getByText(/Stale Projection Store marked activated/)).toBeTruthy()
    })
    expect(screen.queryByText(/asgn_stale marked activated/)).toBeNull()
  })

  it('formats the delivered date rather than printing the wire ISO string', async () => {
    stubWithStaleProjection()
    renderActivationPage()

    expect(await screen.findByText('Stale Projection Store')).toBeTruthy()
    expect(screen.queryByText('2026-08-01T00:00:00.000Z')).toBeNull()
  })
})

// D-16 (T4.1b): "Batches ready to send to CWD", the card above the worklist.
//
// TWO FIXED CONTRACTS are exercised here and neither is invented by the portal:
//   the `activation` report row now also carries `batchId` (the wire `btch_` id,
//   null for a legacy pre-batch row) and `bankDisplay`
//   (services/analytics/src/mediation.ts's activationRow); and
//   GET /ops/reports/activation/batch/:btchId/xlsx returns the sheet as a
//   BINARY body with a Content-Disposition filename, 404 when that batch has
//   nothing awaiting activation.
//
// The send itself is POST /ops/assignments/request-activation, which
// `requestActivation` in api/endpoints.ts has always described and which had no
// caller in the portal until this card.
describe('ActivationPage: batches ready to send to CWD', () => {
  // btch_alpha: TWO dispatches and THREE devices, deliberately different
  // numbers. The sheet carries one row per DEVICE, so a card that counted
  // dispatches and called them devices would understate what the CWD receives,
  // and a fixture where the two counts agreed could not catch that.
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
        simActivationStatus: null,
        activationDate: null,
        activationFailureReason: null,
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
        simActivationStatus: null,
        activationDate: null,
        activationFailureReason: null,
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
        simActivationStatus: null,
        activationDate: null,
        activationFailureReason: null,
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
        simActivationStatus: null,
        activationDate: null,
        activationFailureReason: null,
      },
    ],
    watermark: { asOf: null, perTopic: {} },
  }

  // The xlsx route's response, faked as a plain object rather than a real
  // `Response`, for the reason apps/vendor-portal/test/features/pull.test.tsx
  // records: the body is OPAQUE CARGO and the portal must hand it straight to
  // the browser, so `text`/`arrayBuffer` are spies that must never be called.
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
  // wrapped so `.click()` is a spy instead of a real navigation. Copied from
  // test/features/reports.test.tsx's CSV-export test, which needed exactly this.
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

  // The batch row that owns a given action button. The same idiom the row tests
  // above use with `.closest('tr')`: no test-only attribute is added to the
  // page just to be findable.
  function batchRowFor(batchId: string): HTMLElement {
    const button = screen.getByRole('button', { name: new RegExp(`download excel for ${batchId}`, 'i') })
    return button.closest('li')!
  }

  async function confirmSendInDialog(): Promise<void> {
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /mark sent to cwd/i }))
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

  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    // The createElement spy would otherwise outlive its test: this file has no
    // global restoreMocks, and a leaked spy silently changes every later render.
    vi.restoreAllMocks()
  })

  it('groups the worklist by batch and counts dispatches and DEVICES separately', async () => {
    stubBatches()
    renderActivationPage()

    expect(await screen.findByText('Batches ready to send to CWD')).toBeTruthy()

    const alpha = batchRowFor('btch_alpha')
    expect(within(alpha).getByText('btch_alpha')).toBeTruthy()
    expect(within(alpha).getByText('2 dispatches')).toBeTruthy()
    // THREE devices from TWO dispatches: the sheet has one row per device.
    expect(within(alpha).getByText('3 devices')).toBeTruthy()

    const beta = batchRowFor('btch_beta')
    expect(within(beta).getByText('1 dispatch')).toBeTruthy()
    expect(within(beta).getByText('1 device')).toBeTruthy()
  })

  it('links each batch id to its batch page', async () => {
    stubBatches()
    renderActivationPage()

    await screen.findByText('Batches ready to send to CWD')
    const link = within(batchRowFor('btch_alpha')).getByRole('link', { name: /btch_alpha/i })
    expect(link.getAttribute('href')).toBe('/batches/btch_alpha')
  })

  it('downloads the batch xlsx from the batch route and saves it under the SERVED filename, without ever reading the bytes', async () => {
    const textSpy = vi.fn(async () => '')
    const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(0))
    const fakeBlob = { text: textSpy, arrayBuffer: arrayBufferSpy }
    const calls = stubBatches((url) =>
      url.includes('/xlsx') ? xlsxResponse('activation-btch_alpha.xlsx', fakeBlob) : undefined,
    )
    const { objectUrlArgs, anchors } = captureSaveBlob()

    renderActivationPage()
    await screen.findByText('Batches ready to send to CWD')
    await userEvent.click(screen.getByRole('button', { name: /download excel for btch_alpha/i }))

    const download = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/xlsx'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(download.url).toContain('/ops/reports/activation/batch/btch_alpha/xlsx')

    // The filename comes off Content-Disposition, never re-derived client-side.
    await vi.waitFor(() => {
      expect(anchors.some((a) => a.download === 'activation-btch_alpha.xlsx')).toBe(true)
    })
    // And it is the SERVED blob object that was handed to the browser.
    expect(objectUrlArgs).toContain(fakeBlob)
    expect(textSpy).not.toHaveBeenCalled()
    expect(arrayBufferSpy).not.toHaveBeenCalled()
  })

  it('renders a plain sentence, not a thrown error, when the batch route answers 404', async () => {
    stubBatches((url) => (url.includes('/xlsx') ? xlsxResponse(null, { text: vi.fn(), arrayBuffer: vi.fn() }, 404) : undefined))
    captureSaveBlob()

    renderActivationPage()
    await screen.findByText('Batches ready to send to CWD')
    await userEvent.click(screen.getByRole('button', { name: /download excel for btch_alpha/i }))

    expect(await screen.findByText(/nothing awaiting activation/i)).toBeTruthy()
    // The other batch is untouched: one batch's 404 is not the card's verdict.
    expect(within(batchRowFor('btch_beta')).queryByText(/nothing awaiting activation/i)).toBeNull()
  })

  it('marking a batch sent opens the confirmation and POSTs only after it is confirmed', async () => {
    const calls = stubBatches((url) =>
      url.includes('/request-activation')
        ? jsonResponse({ deduped: false, recorded: ['asgn_1', 'asgn_2'], unknown: [] })
        : undefined,
    )

    renderActivationPage()
    await screen.findByText('Batches ready to send to CWD')
    await userEvent.click(screen.getByRole('button', { name: /mark btch_alpha sent to cwd/i }))

    // The first click only asks. Nothing has been written.
    expect(calls.some((c) => c.url.includes('/request-activation'))).toBe(false)
    await confirmSendInDialog()

    const write = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/request-activation'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(write.init.method).toBe('POST')
    // The GROUP's dispatch ids, and only those: btch_beta's is not in the send.
    expect(parseBody(write).dispatchIds).toEqual(['asgn_1', 'asgn_2'])
    expect(headerValue(write, 'Idempotency-Key')).toBeTruthy()
  })

  it('counts recorded and unknown from the RESPONSE, never the number requested', async () => {
    stubBatches((url) =>
      url.includes('/request-activation')
        ? jsonResponse({ deduped: false, recorded: ['asgn_1'], unknown: ['asgn_2'] })
        : undefined,
    )

    renderActivationPage()
    await screen.findByText('Batches ready to send to CWD')
    await userEvent.click(screen.getByRole('button', { name: /mark btch_alpha sent to cwd/i }))
    await confirmSendInDialog()

    // Two were asked for; one was recorded and one was not found. Saying
    // "2 recorded" is the exact false claim this assertion exists to block.
    expect(await screen.findByText(/1 recorded/i)).toBeTruthy()
    expect(screen.getByText(/1 not found/i)).toBeTruthy()
    expect(screen.queryByText(/2 recorded/i)).toBeNull()
  })

  // THE REGRESSION THAT MATTERS MOST. REQUEST_SENT_TO_CWD is an
  // activation-REQUEST record, not an activation: nobody has activated anything
  // yet, so the rows must stay on the worklist and stay actionable. Hiding them
  // would make rows vanish before the CWD confirmed a single device.
  it('keeps a sent batch and its rows on the worklist, still actionable', async () => {
    stubBatches((url) =>
      url.includes('/request-activation')
        ? jsonResponse({ deduped: false, recorded: ['asgn_1', 'asgn_2'], unknown: [] })
        : undefined,
    )

    renderActivationPage()
    await screen.findByText('Batches ready to send to CWD')
    await userEvent.click(screen.getByRole('button', { name: /mark btch_alpha sent to cwd/i }))
    await confirmSendInDialog()

    expect(await screen.findByText(/2 recorded/i)).toBeTruthy()
    // Both of the batch's rows are still in the table below.
    expect(screen.getByText('asgn_1')).toBeTruthy()
    expect(screen.getByText('asgn_2')).toBeTruthy()
    expect(screen.getByText('4 rows')).toBeTruthy()
    // Still actionable: the row's own activate control is still there.
    const row = screen.getByText('asgn_1').closest('tr')!
    expect(within(row).getByRole('button', { name: /mark activated/i })).toBeTruthy()
    // And the batch itself is still on the card, not hidden by its own send.
    expect(within(batchRowFor('btch_alpha')).getByText('2 dispatches')).toBeTruthy()
  })

  // A legacy pre-batch row is shown honestly rather than given a fabricated id
  // or dropped: it is still awaiting activation and still on the worklist, it
  // just has no batch for a download to name.
  it('renders a batchless legacy group with no actions and says why', async () => {
    stubBatches()
    renderActivationPage()

    await screen.findByText('Batches ready to send to CWD')
    const legacy = screen.getByText('No batch').closest('li')!
    expect(within(legacy).getByText('1 dispatch')).toBeTruthy()
    expect(within(legacy).queryByRole('button')).toBeNull()
    expect(within(legacy).getByText(/needs a batch to name/i)).toBeTruthy()
    // The row is still on the worklist below, not hidden.
    expect(screen.getByText('asgn_legacy')).toBeTruthy()
  })

  it('shows the number of banks rather than picking one when a batch spans several', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          rows: [
            { ...BATCH_ROWS.rows[0]!, batchId: 'btch_mixed', bankCode: 'HDFC' },
            { ...BATCH_ROWS.rows[1]!, batchId: 'btch_mixed', bankCode: 'ICIC' },
          ],
          watermark: { asOf: null, perTopic: {} },
        }),
      ),
    )
    renderActivationPage()

    await screen.findByText('Batches ready to send to CWD')
    expect(within(batchRowFor('btch_mixed')).getByText('2 banks')).toBeTruthy()
  })

  it('renders no batches card at all when nothing is awaiting activation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ rows: [], watermark: { asOf: null, perTopic: {} } })))
    renderActivationPage()

    // The worklist's own empty state is the page's answer; a card announcing
    // zero batches beside it would be a second way of saying nothing.
    expect(await screen.findByText(/nothing is awaiting activation/i)).toBeTruthy()
    expect(screen.queryByText('Batches ready to send to CWD')).toBeNull()
  })
})
