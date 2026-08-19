import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { ToastProvider } from '../../src/ui/Toast.js'
import { BatchablePools } from '../../src/features/fulfillment/BatchablePools.js'
import type { PoolEntryRow } from '../../src/api/endpoints.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// Redesign step 3, the flagship. The batch trigger used to be a form with two
// free-text boxes labelled `tnnt_...` and `prg_...`. Nobody remembers those, so
// the real workflow was to find them elsewhere and paste them back.
//
// Now the screen IS the queue: the operator sees what is waiting and clicks
// Trigger on it. The ids travel from the rows, never from a keyboard.
//
// GROUPED BY (TENANT, PROGRAM), NOT BY BANK. Batching is per (tenant, program),
// and D7 pools many aggregator bank codes beneath ONE tenant. Grouping by bank
// would render several rows whose Trigger buttons all fire the same batch, which
// is worse than the form it replaces: it would look like a choice and not be one.
// Bank is shown as CONTEXT inside the group.

function entry(over: Partial<PoolEntryRow> = {}): PoolEntryRow {
  return {
    asgnId: 'asgn_50000000008008000000000001',
    dispatchGroup: null,
    replacementRaised: false,
    merchantDisplayName: 'BRILLIANT PERFUME',
    merchantLegalName: 'BRILLIANT PERFUME',
    bankReferenceCode: '3',
    bankDisplayName: 'GSCB',
    branchCode: '30',
    soundbox: true,
    standeeCount: 1,
    stickerCount: 2,
    poolStatus: 'POOLED',
    dispatchState: null,
    shipToSuperseded: false,
    batch: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    tenantId: 'tnnt_50000000008008000000000001',
    programId: 'prog_50000000008008000000000001',
    ...over,
  }
}

interface Call { url: string; init: RequestInit }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function withProviders(node: React.ReactNode) {
  // ToastProvider included because App.tsx always provides it: the trigger's
  // success confirmation IS a toast now, so a harness without the provider
  // would silently swallow the very thing several tests assert on.
  return (
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <ToastProvider>{node}</ToastProvider>
      </AuthProvider>
    </MemoryRouter>
  )
}

function stub(entries: PoolEntryRow[], triggerResult: unknown = { btchId: 'btch_50000000008008000000000009' }) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (url.includes('/ops/batches/trigger')) return jsonResponse(triggerResult)
    if (url.includes('/ops/pool')) return jsonResponse(entries)
    return jsonResponse({})
  }))
  return calls
}

// TRIGGERING IS TWO STEPS NOW. Forming a batch cannot be undone, so the row's
// "Trigger batch" opens a confirmation, and the confirmation is where the reason
// the edge requires (BRD 5.3.4 force dispatch) is typed and where "Create batch"
// actually posts. Every test that means to trigger goes through both.
//
// Note what did NOT come back: the free-text tnnt_/prog_ boxes. A reason is
// prose an operator writes from their own head, not an id they have to go and
// look up somewhere else, so it is the opposite of the friction this screen
// removed.
const A_REASON = 'bank collection cut-off is today'

/** Open the confirmation for a pool (the first one unless told otherwise). */
async function openTrigger(which = 0): Promise<void> {
  const buttons = await screen.findAllByRole('button', { name: /trigger batch/i })
  await userEvent.click(buttons[which]!)
}

/** Open the confirmation and type the reason into it. */
async function typeReason(text = A_REASON, which = 0): Promise<HTMLElement> {
  await openTrigger(which)
  const box = await screen.findByLabelText(/reason/i)
  await userEvent.type(box, text)
  return box
}

/** The button inside the confirmation that actually posts. */
function confirmButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /create batch/i }) as HTMLButtonElement
}

async function confirmTrigger(): Promise<void> {
  await userEvent.click(confirmButton())
}

describe('BatchablePools: trigger a batch without typing an id', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  it('shows one row per batchable pool, not one per bank', async () => {
    stub([
      entry({ asgnId: 'asgn_a', bankDisplayName: 'GSCB', bankReferenceCode: '3' }),
      entry({ asgnId: 'asgn_b', bankDisplayName: 'GSCB', bankReferenceCode: '18' }),
      entry({ asgnId: 'asgn_c', bankDisplayName: 'GSCB', bankReferenceCode: '1523' }),
    ])
    render(withProviders(<BatchablePools />))
    expect(await screen.findAllByRole('button', { name: /trigger/i })).toHaveLength(1)
  })

  it('counts the records waiting as two big stats against the two thresholds', async () => {
    stub([entry({ asgnId: 'asgn_a' }), entry({ asgnId: 'asgn_b' })])
    render(
      withProviders(<BatchablePools lotSizeFor={() => 50} maxWaitSeconds={7 * 86_400} />),
    )
    // The pdf-generation design: "2/50 records pooled" and "0/7 days queued",
    // two sub-cards, not one dense sentence to parse.
    expect(await screen.findByText('records pooled')).toBeTruthy()
    expect(screen.getByText('/50')).toBeTruthy()
    expect(screen.getByText('days queued')).toBeTruthy()
    expect(screen.getByText('/7')).toBeTruthy()
  })

  it('renders both stats without denominators when no thresholds are known', async () => {
    stub([entry({ asgnId: 'asgn_a' }), entry({ asgnId: 'asgn_b' })])
    render(withProviders(<BatchablePools />))
    // A caller that holds no config shows the live numbers alone rather than
    // denominators this component invented.
    expect(await screen.findByText('records pooled')).toBeTruthy()
    expect(screen.queryByText(/^\//)).toBeNull()
  })

  it('groups by (tenant, program) even when the pool spans many aggregator banks', async () => {
    stub([
      entry({ asgnId: 'asgn_a', bankReferenceCode: '3', bankDisplayName: 'Bank A' }),
      entry({ asgnId: 'asgn_b', bankReferenceCode: '18', bankDisplayName: 'Bank B' }),
    ])
    render(withProviders(<BatchablePools />))
    // Only one row (one Trigger button) covers both aggregators, and the bank
    // names appear in the CONFIRMATION, where the operator is deciding what to
    // claim - the row itself leads with the two threshold stats now.
    expect(await screen.findAllByRole('button', { name: /trigger/i })).toHaveLength(1)
    await openTrigger()
    expect(await screen.findByText(/Bank A, Bank B/)).toBeTruthy()
  })

  it('separates two genuinely different pools', async () => {
    stub([
      entry({ asgnId: 'asgn_a', tenantId: 'tnnt_1', programId: 'prog_1' }),
      entry({ asgnId: 'asgn_b', tenantId: 'tnnt_2', programId: 'prog_2' }),
    ])
    render(withProviders(<BatchablePools />))
    expect(await screen.findAllByRole('button', { name: /trigger/i })).toHaveLength(2)
  })

  // The whole point of the step.
  it('posts the pool ids taken FROM THE ROW, with no id ever typed', async () => {
    const calls = stub([entry({ tenantId: 'tnnt_real', programId: 'prog_real' })])
    render(withProviders(<BatchablePools />))
    await typeReason()
    await confirmTrigger()

    const call = calls.find((c) => c.url.includes('/ops/batches/trigger'))
    expect(call).toBeTruthy()
    expect(call!.init.method).toBe('POST')
    const body = JSON.parse(String(call!.init.body)) as Record<string, string>
    expect(body.tenantWire).toBe('tnnt_real')
    expect(body.programWire).toBe('prog_real')
  })

  it('sends a fresh Idempotency-Key, so a double click cannot double batch', async () => {
    const calls = stub([entry()])
    render(withProviders(<BatchablePools />))
    await typeReason()
    await confirmTrigger()
    const call = calls.find((c) => c.url.includes('/ops/batches/trigger'))
    const headers = new Headers(call!.init.headers)
    expect(headers.get('Idempotency-Key')).toBeTruthy()
  })

  it('names the batch it created, so the operator can go find it', async () => {
    stub([entry()])
    render(withProviders(<BatchablePools />))
    await typeReason()
    await confirmTrigger()
    expect(await screen.findByText(/btch_50000000008008000000000009/)).toBeTruthy()
  })

  // A null response is a real outcome, not an error: nothing was eligible.
  it('says nothing was eligible rather than showing a failure', async () => {
    stub([entry()], null)
    render(withProviders(<BatchablePools />))
    await typeReason()
    await confirmTrigger()
    expect(await screen.findByText(/nothing to batch/i)).toBeTruthy()
  })

  it('says the queue is empty rather than rendering a bare table', async () => {
    stub([])
    render(withProviders(<BatchablePools />))
    expect(await screen.findByText(/nothing waiting/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /trigger/i })).toBeNull()
  })

  it('offers no free-text id box anywhere, even when the pool fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('edge down') }))
    render(withProviders(<BatchablePools />))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

// This component is NOT alone on the Batches page. Triggering re-read its own
// groups and correctly showed "Nothing waiting to be batched", while the
// pending-pool TABLE rendered right below it, owned by the parent and reading
// the same endpoint, still listed those records as POOLED / not batched.
// One screen, two halves, disagreeing in front of the operator.
describe('BatchablePools: telling the rest of the page that the pool changed', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  it('calls onTriggered after a successful trigger, so a sibling list can re-read', async () => {
    stub([entry()])
    const onTriggered = vi.fn()
    render(withProviders(<BatchablePools onTriggered={onTriggered} />))

    await typeReason()
    await confirmTrigger()

    await vi.waitFor(() => {
      expect(onTriggered).toHaveBeenCalledTimes(1)
    })
  })

  it('does NOT call onTriggered when the trigger fails, because nothing changed', async () => {
    const calls: Call[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('/ops/batches/trigger')) {
        return new Response(JSON.stringify({ message: 'nope' }), { status: 500 })
      }
      if (url.includes('/ops/pool')) return jsonResponse([entry()])
      return jsonResponse({})
    }))
    const onTriggered = vi.fn()
    render(withProviders(<BatchablePools onTriggered={onTriggered} />))

    await typeReason()
    await confirmTrigger()

    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/batches/trigger'))).toBe(true)
    })
    expect(onTriggered).not.toHaveBeenCalled()
  })

  it('is optional, so a caller that does not need the signal still works', async () => {
    stub([entry()])
    render(withProviders(<BatchablePools />))
    await typeReason()
    await confirmTrigger()
    expect(await screen.findByText(/btch_50000000008008000000000009/)).toBeTruthy()
  })

  it('counts in words that agree with the number, including at one', async () => {
    stub([entry()])
    render(withProviders(<BatchablePools />))
    // The stat label goes singular where the count is one.
    expect(await screen.findByText('record pooled')).toBeTruthy()
  })
})

// BRD 5.3.4 force dispatch: a manual trigger forms a batch BELOW the lot size
// the pool was configured for. It is an operator overriding the pool's own
// economics, so the record of it has to say why, not just who.
describe('BatchablePools: the force-dispatch reason', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  // The guard moved WITH the field: the row's button now opens the confirmation
  // (it can always do that), and the confirmation cannot be confirmed until the
  // reason is there. Same rule, asserted where it now lives.
  it('cannot be confirmed until a reason is typed, so the field is discovered by looking, not by being rejected', async () => {
    stub([entry()])
    render(withProviders(<BatchablePools />))
    await openTrigger()
    expect(confirmButton().disabled).toBe(true)

    await userEvent.type(await screen.findByLabelText(/reason/i), A_REASON)
    expect(confirmButton().disabled).toBe(false)
  })

  it('treats a whitespace-only reason as no reason at all', async () => {
    stub([entry()])
    render(withProviders(<BatchablePools />))
    await typeReason('   ')
    expect(confirmButton().disabled).toBe(true)
  })

  it('states what the batch will claim before it is created', async () => {
    stub([entry({ asgnId: 'asgn_a' }), entry({ asgnId: 'asgn_b' })])
    render(withProviders(<BatchablePools />))
    await openTrigger()
    // The dialog names the consequence and the size, because the pool list it
    // was read from is behind the overlay by now.
    expect(await screen.findByText(/records that arrive afterwards go into the next batch/i)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('posts the typed reason in the body, trimmed', async () => {
    const calls = stub([entry()])
    render(withProviders(<BatchablePools />))
    await typeReason('  courier is collecting at 4pm  ')
    await confirmTrigger()

    const call = calls.find((c) => c.url.includes('/ops/batches/trigger'))
    expect(call).toBeTruthy()
    const body = JSON.parse(String(call!.init.body)) as Record<string, string>
    expect(body.reason).toBe('courier is collecting at 4pm')
  })

  // One shared box would carry whatever was typed for one pool into the trigger
  // for another, which is precisely the audit trail this field exists to stop
  // being wrong.
  it('keeps the reason PER POOL, so typing for one pool does not arm the other', async () => {
    const calls = stub([
      entry({ asgnId: 'asgn_a', tenantId: 'tnnt_1', programId: 'prog_1' }),
      entry({ asgnId: 'asgn_b', tenantId: 'tnnt_2', programId: 'prog_2' }),
    ])
    render(withProviders(<BatchablePools />))

    // The reason typed for the SECOND pool belongs to that pool alone.
    await typeReason('only the second pool', 1)
    await confirmTrigger()

    const call = calls.find((c) => c.url.includes('/ops/batches/trigger'))
    const body = JSON.parse(String(call!.init.body)) as Record<string, string>
    expect(body.tenantWire).toBe('tnnt_2')
    expect(body.reason).toBe('only the second pool')

    // The created-batch dialog now has to be ANSWERED before the page is
    // reachable again (17 Aug 2026): it is modal on purpose, so that the batch
    // id it carries cannot be lost by clicking past it. Dismissing it is what an
    // operator staying on this screen does.
    await userEvent.click(await screen.findByRole('button', { name: /stay on batches/i }))

    // And the first pool's confirmation opens empty, unarmed: one shared box
    // would have carried that reason into a different batch's audit record.
    await openTrigger(0)
    expect((await screen.findByLabelText(/reason/i)).getAttribute('value')).not.toBe('only the second pool')
    expect(confirmButton().disabled).toBe(true)
  })
})

// The trigger's success has been three things. First a static inline line
// ("Batch created: btch_..."), then a toast carrying the id as a chip, and now
// (17 Aug 2026) a MODAL that waits to be answered. The toast lost twice over: a
// four-second timer is a race for the one id the operator needs next, and
// forming a batch ends one task and starts another, which is a choice
// ("go to the batch" or "stay with the pool") and not a glance.
//
// So this suite asserts the modal: it names the batch, offers the id as a real
// link, does not vanish, and both exits work. The null outcome ("nothing was
// eligible") deliberately stays inline; it is a condition to read.
describe('BatchablePools: the created batch arrives as a modal that waits', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  function renderWithToastAndRoutes() {
    return render(
      <MemoryRouter initialEntries={['/']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <ToastProvider>
            <Routes>
              <Route path="/" element={<BatchablePools />} />
              <Route path="/batches/:btchId" element={<p>batch page probe</p>} />
            </Routes>
          </ToastProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  it('names the created batch and offers its id as a link through to that batch page', async () => {
    stub([entry()], { btchId: 'btch_50000000008008000000000009' })
    renderWithToastAndRoutes()

    await typeReason()
    await confirmTrigger()

    expect(await screen.findByRole('dialog', { name: /batch created/i })).toBeTruthy()
    // A real link, not a button: the id is the one thing worth opening in a new
    // tab or copying, which a button cannot offer.
    const idLink = screen.getByRole('link', { name: 'btch_50000000008008000000000009' })
    expect(idLink.getAttribute('href')).toBe('/batches/btch_50000000008008000000000009')

    await userEvent.click(idLink)
    expect(await screen.findByText('batch page probe')).toBeTruthy()
    // Acted on means gone: the dialog must not linger over the page it just
    // sent the operator to.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('waits to be answered: modal, so a stray click cannot throw the id away', async () => {
    stub([entry()], { btchId: 'btch_50000000008008000000000009' })
    renderWithToastAndRoutes()

    await typeReason()
    await confirmTrigger()
    await screen.findByRole('dialog', { name: /batch created/i })

    // Asserted as STATE rather than by clicking outside, because the click is
    // not performable: a modal dialog puts `pointer-events: none` on the body,
    // which is the very mechanism that makes a stray dismissal impossible. The
    // page behind is inert until one of the two exits is taken.
    expect(document.body.getAttribute('data-scroll-locked')).toBe('1')
    expect(document.body.style.pointerEvents).toBe('none')
    // And nothing has navigated on its own.
    expect(screen.queryByText('batch page probe')).toBeNull()
    expect(screen.getByRole('link', { name: 'btch_50000000008008000000000009' })).toBeTruthy()
  })

  it('the other exit stays put: "Stay on batches" closes without navigating', async () => {
    stub([entry()], { btchId: 'btch_50000000008008000000000009' })
    renderWithToastAndRoutes()

    await typeReason()
    await confirmTrigger()
    await screen.findByRole('dialog', { name: /batch created/i })

    await userEvent.click(screen.getByRole('button', { name: /stay on batches/i }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('batch page probe')).toBeNull()
  })

  it('shows NO dialog for the null outcome; "nothing to batch" stays inline', async () => {
    stub([entry()], null)
    renderWithToastAndRoutes()

    await typeReason()
    await confirmTrigger()

    expect(await screen.findByText(/nothing to batch/i)).toBeTruthy()
    expect(screen.queryByText(/batch created/i)).toBeNull()
  })
})
