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
    await userEvent.click(await screen.findByRole('button', { name: /trigger/i }))
    const call = calls.find((c) => c.url.includes('/ops/batches/trigger'))
    const headers = new Headers(call!.init.headers)
    expect(headers.get('Idempotency-Key')).toBeTruthy()
  })

  it('names the batch it created, so the operator can go find it', async () => {
    stub([entry()])
    render(withProviders(<BatchablePools />))
    await userEvent.click(await screen.findByRole('button', { name: /trigger/i }))
    expect(await screen.findByText(/btch_50000000008008000000000009/)).toBeTruthy()
  })

  // A null response is a real outcome, not an error: nothing was eligible.
  it('says nothing was eligible rather than showing a failure', async () => {
    stub([entry()], null)
    render(withProviders(<BatchablePools />))
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
