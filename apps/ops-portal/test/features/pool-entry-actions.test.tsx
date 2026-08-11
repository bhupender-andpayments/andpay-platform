import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { PoolEntryActions } from '../../src/features/fulfillment/PoolEntryActions.js'
import type { PoolEntryRow } from '../../src/api/endpoints.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// Redesign step 8, the last of the typed wire ids. Hold and Release were two
// standalone forms, each asking the operator to type an `asgn_...` id.
//
// The justification in those files was that "no ops-edge read discovers one
// anywhere, so free text is the only honest source". That was TRUE when it was
// written and stopped being true when the P2-1 object-spine reads landed:
// GET /ops/pool returns asgnId on every row. The premise expired and nobody
// went back to it.
//
// Hold and Release are one-click, and which one applies is decided by the row's
// own pool status, so they belong ON the row rather than in a form.

function entry(over: Partial<PoolEntryRow> = {}): PoolEntryRow {
  return {
    asgnId: 'asgn_50000000008008000000000001',
    dispatchGroup: null,
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
    tenantId: 'tnnt_1',
    programId: 'prog_1',
    ...over,
  }
}

interface Call { url: string; init: RequestInit }

function stub(): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ deduped: false, released: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
  return calls
}

function renderActions(row: PoolEntryRow, onChanged = vi.fn()) {
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <PoolEntryActions row={row} onChanged={onChanged} />
      </AuthProvider>
    </MemoryRouter>,
  )
  return onChanged
}

describe('PoolEntryActions: the action is on the row it acts on', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  it('offers Hold on a pooled entry', () => {
    stub()
    renderActions(entry({ poolStatus: 'POOLED' }))
    expect(screen.getByRole('button', { name: /^hold$/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /release/i })).toBeNull()
  })

  // Only a HELD entry can be released, and the row already knows which it is.
  // The old forms could not: they took any id and let the edge reject it.
  it('offers Release on a held entry, and not Hold', () => {
    stub()
    renderActions(entry({ poolStatus: 'HELD' }))
    expect(screen.getByRole('button', { name: /release/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^hold$/i })).toBeNull()
  })

  it('offers neither once the entry is batched', () => {
    stub()
    renderActions(entry({ poolStatus: 'BATCHED' }))
    expect(screen.queryByRole('button', { name: /^hold$|release/i })).toBeNull()
  })

  it('holds using the row own id, with no id typed', async () => {
    const calls = stub()
    renderActions(entry({ asgnId: 'asgn_real', poolStatus: 'POOLED' }))
    await userEvent.click(screen.getByRole('button', { name: /^hold$/i }))
    const call = calls.find((c) => c.url.includes('/ops/records/asgn_real/hold'))
    expect(call).toBeTruthy()
    expect(call!.init.method).toBe('POST')
    expect(new Headers(call!.init.headers).get('Idempotency-Key')).toBeTruthy()
  })

  it('releases using the row own id', async () => {
    const calls = stub()
    renderActions(entry({ asgnId: 'asgn_real', poolStatus: 'HELD' }))
    await userEvent.click(screen.getByRole('button', { name: /release/i }))
    expect(calls.some((c) => c.url.includes('/ops/records/asgn_real/release'))).toBe(true)
  })

  it('tells the table to re-read, so the row reflects what just happened', async () => {
    stub()
    const onChanged = renderActions(entry({ poolStatus: 'POOLED' }))
    await userEvent.click(screen.getByRole('button', { name: /^hold$/i }))
    await vi.waitFor(() => {
      expect(onChanged).toHaveBeenCalled()
    })
  })

  it('surfaces a failure on the row rather than silently doing nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('edge down') }))
    renderActions(entry({ poolStatus: 'POOLED' }))
    await userEvent.click(screen.getByRole('button', { name: /^hold$/i }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
