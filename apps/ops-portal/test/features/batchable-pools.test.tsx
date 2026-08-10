import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
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
  return (
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>{node}</AuthProvider>
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

// BRD 5.3.4 force dispatch: the trigger now REQUIRES a reason, and the button
// is disabled until one is typed. Every test below that means to trigger fills
// the row's Reason box first; the tests that assert the disabled state and the
// posted body are further down.
//
// Note what did NOT come back: the free-text tnnt_/prog_ boxes. A reason is
// prose an operator writes from their own head, not an id they have to go and
// look up somewhere else, so it is the opposite of the friction this screen
// removed.
const A_REASON = 'bank collection cut-off is today'

async function typeReason(text = A_REASON): Promise<HTMLElement> {
  const boxes = await screen.findAllByLabelText(/reason/i)
  await userEvent.type(boxes[0]!, text)
  return boxes[0]!
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

  it('counts the records waiting in the pool', async () => {
    stub([entry({ asgnId: 'asgn_a' }), entry({ asgnId: 'asgn_b' })])
    render(withProviders(<BatchablePools />))
    expect(await screen.findByText(/2 records/i)).toBeTruthy()
  })

  it('shows how many aggregator banks the pool spans, as context', async () => {
    stub([
      entry({ asgnId: 'asgn_a', bankReferenceCode: '3' }),
      entry({ asgnId: 'asgn_b', bankReferenceCode: '18' }),
    ])
    render(withProviders(<BatchablePools />))
    expect(await screen.findByText(/2 banks/i)).toBeTruthy()
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
    await userEvent.click(await screen.findByRole('button', { name: /trigger/i }))

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
    await userEvent.click(await screen.findByRole('button', { name: /trigger/i }))
    const call = calls.find((c) => c.url.includes('/ops/batches/trigger'))
    const headers = new Headers(call!.init.headers)
    expect(headers.get('Idempotency-Key')).toBeTruthy()
  })

  it('names the batch it created, so the operator can go find it', async () => {
    stub([entry()])
    render(withProviders(<BatchablePools />))
    await typeReason()
    await userEvent.click(await screen.findByRole('button', { name: /trigger/i }))
    expect(await screen.findByText(/btch_50000000008008000000000009/)).toBeTruthy()
  })

  // A null response is a real outcome, not an error: nothing was eligible.
  it('says nothing was eligible rather than showing a failure', async () => {
    stub([entry()], null)
    render(withProviders(<BatchablePools />))
    await typeReason()
    await userEvent.click(await screen.findByRole('button', { name: /trigger/i }))
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
    await userEvent.click(await screen.findByRole('button', { name: /trigger batch/i }))

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
    await userEvent.click(await screen.findByRole('button', { name: /trigger batch/i }))

    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/batches/trigger'))).toBe(true)
    })
    expect(onTriggered).not.toHaveBeenCalled()
  })

  it('is optional, so a caller that does not need the signal still works', async () => {
    stub([entry()])
    render(withProviders(<BatchablePools />))
    await typeReason()
    await userEvent.click(await screen.findByRole('button', { name: /trigger batch/i }))
    expect(await screen.findByText(/btch_50000000008008000000000009/)).toBeTruthy()
  })

  it('counts in words that agree with the number, including at one', async () => {
    stub([entry()])
    render(withProviders(<BatchablePools />))
    // One record, one bank: "1 records across 1 banks" was what it said.
    expect(await screen.findByText(/1 record across 1 bank,/)).toBeTruthy()
  })
})

// BRD 5.3.4 force dispatch: a manual trigger forms a batch BELOW the lot size
// the pool was configured for. It is an operator overriding the pool's own
// economics, so the record of it has to say why, not just who.
describe('BatchablePools: the force-dispatch reason', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  it('disables the trigger until a reason is typed, so the field is discovered by looking, not by being rejected', async () => {
    stub([entry()])
    render(withProviders(<BatchablePools />))
    const button = await screen.findByRole('button', { name: /trigger batch/i })
    expect((button as HTMLButtonElement).disabled).toBe(true)

    await typeReason()
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })

  it('treats a whitespace-only reason as no reason at all', async () => {
    stub([entry()])
    render(withProviders(<BatchablePools />))
    const button = await screen.findByRole('button', { name: /trigger batch/i })
    await typeReason('   ')
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('posts the typed reason in the body, trimmed', async () => {
    const calls = stub([entry()])
    render(withProviders(<BatchablePools />))
    await typeReason('  courier is collecting at 4pm  ')
    await userEvent.click(await screen.findByRole('button', { name: /trigger batch/i }))

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

    const boxes = await screen.findAllByLabelText(/reason/i)
    expect(boxes).toHaveLength(2)
    await userEvent.type(boxes[1]!, 'only the second pool')

    const buttons = await screen.findAllByRole('button', { name: /trigger batch/i })
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true)
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false)

    await userEvent.click(buttons[1]!)
    const call = calls.find((c) => c.url.includes('/ops/batches/trigger'))
    const body = JSON.parse(String(call!.init.body)) as Record<string, string>
    expect(body.tenantWire).toBe('tnnt_2')
    expect(body.reason).toBe('only the second pool')
  })
})
