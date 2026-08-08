import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { AppRoutes } from '../../src/routes.js'
import { clearAccessToken } from '../../src/api/tokenStore.js'

// P-C, deep-link survival on a COLD LOAD.
//
// FOUND IN A REAL BROWSER, NOT BY THE SUITE. Opening /fulfillment directly
// landed on /command-center, silently swallowing the redirect. The nav suite
// passed the whole time because its harness logs in FIRST and only then mounts
// the routes, so the principal is already set and the race never happens.
//
// The race: on a cold load the in-memory access token is gone, so AuthProvider
// fires POST /session/rehydrate asynchronously. RequireAuth renders on the
// SAME tick with principal === null and immediately redirects to /login,
// throwing away where the operator was going. Rehydrate then resolves, the
// login route sees a principal and sends them to the landing page.
//
// These tests mount the REAL AppRoutes with a rehydrate that succeeds, which is
// exactly the cold-reload path, and assert the operator arrives where they
// asked to go.
vi.mock('../../src/features/dashboards/TilesPage.js', () => ({
  TilesPage: () => <h1>Command Center</h1>,
}))
vi.mock('../../src/features/fulfillment/FulfillmentPage.js', () => ({
  FulfillmentPage: () => <h1>Batches</h1>,
}))
vi.mock('../../src/features/fulfillment/BatchDetailPage.js', () => ({
  BatchDetailPage: () => <h1>Batch detail</h1>,
}))
vi.mock('../../src/features/queues/QueuesPage.js', () => ({
  QueuesPage: () => <h1>Queues</h1>,
}))

function makeFakeJwt(claims: Record<string, unknown>): string {
  const json = JSON.stringify(claims)
  const base64url = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${base64url}.signature`
}

// A rehydrate that SUCCEEDS but not synchronously, which is the real network
// shape. The delay is what makes the race observable: with a zero-tick stub the
// bug can hide behind React's batching.
function stubSlowRehydrate(): void {
  const token = makeFakeJwt({ sub: 'ops-1', psr: 'role:ops' })
  vi.stubGlobal('fetch', vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 10))
    return new Response(JSON.stringify({ accessToken: token }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
}

function renderCold(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('deep-link survival across a cold reload (P-C)', () => {
  beforeEach(() => { clearAccessToken(); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('lands on the requested section, not the landing page', async () => {
    stubSlowRehydrate()
    renderCold('/queues')
    expect(await screen.findByRole('heading', { name: 'Queues' })).toBeTruthy()
  })

  it('survives a deep link to a batch DETAIL route', async () => {
    stubSlowRehydrate()
    renderCold('/batches/btch_50000000008008000000000001')
    expect(await screen.findByRole('heading', { name: 'Batch detail' })).toBeTruthy()
  })

  // The whole point of the step-1 redirects: they must survive a cold load too,
  // which is the only way anyone actually opens an old bookmark.
  it('still applies the /fulfillment redirect on a cold load', async () => {
    stubSlowRehydrate()
    renderCold('/fulfillment')
    expect(await screen.findByRole('heading', { name: 'Batches' })).toBeTruthy()
  })
})
