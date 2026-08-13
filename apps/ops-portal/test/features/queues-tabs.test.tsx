import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { QueuesPage } from '../../src/features/queues/QueuesPage.js'
import { QuarantineTab } from '../../src/features/queues/QuarantineTab.js'
import { IntakeExceptionsTab } from '../../src/features/queues/IntakeExceptionsTab.js'
import { StatusExceptionsTab } from '../../src/features/queues/StatusExceptionsTab.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// C-2: QueuesPage was 689 lines holding three unrelated screens; each tab now
// lives in its own file.
//
// WHY THIS FILE EXISTS. The page had 4 tests guarding it, which is thin cover
// for moving ~600 lines. The specific way a bad split fails is a component that
// no longer mounts: a missing import, a helper left behind, an export that was
// implicit inside one file and needed declaring once it crossed a file
// boundary. None of that is caught by typecheck alone once a cast is involved,
// and none of it is caught by a suite that only ever renders the default tab.
// So each tab is mounted directly, and the shell is driven through its tab
// strip.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function wrap(ui: React.ReactNode) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  )
}

// The SHELL needs a routed wrapper: the tab moved into the url on 2026-08-12,
// so QueuesPage reads it from useParams and a bare mount only ever redirects.
function wrapShell(path = '/queues/quarantine') {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/queues" element={<QueuesPage />} />
          <Route path="/queues/:tab" element={<QueuesPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('queues tabs after the C-2 split', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
    // Every queue read answers with an empty list: this file is about the
    // components mounting, not about row rendering, which queues.test.tsx owns.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])))
  })
  afterEach(() => {
    cleanup()
  })

  it('mounts the quarantine tab on its own', async () => {
    wrap(<QuarantineTab />)
    expect(await screen.findByText(/show resolved rows/i)).toBeTruthy()
  })

  it('mounts the intake exceptions tab on its own', async () => {
    wrap(<IntakeExceptionsTab />)
    expect(await screen.findByText(/show resolved rows/i)).toBeTruthy()
  })

  it('mounts the status exceptions tab on its own', async () => {
    wrap(<StatusExceptionsTab />)
    expect(await screen.findByText(/show resolved rows/i)).toBeTruthy()
  })

  it('the shell still reaches all three tabs, not just the default one', async () => {
    // The regression a split invites: two tabs are never rendered by any test,
    // so a broken import in either is invisible until an operator clicks it.
    wrapShell()
    expect(await screen.findByRole('heading', { name: /^queues$/i })).toBeTruthy()

    for (const label of [/intake exceptions/i, /status exceptions/i, /quarantine/i]) {
      await userEvent.click(screen.getByRole('button', { name: label }))
      expect(await screen.findByText(/show resolved rows/i)).toBeTruthy()
    }
  })

  // The tab is ADDRESSABLE, which is the whole reason it moved into the url:
  // every link into this page (three Command Center cards, three upload-result
  // links, the workspace block) names a specific queue, and they all used to
  // land on Quarantine regardless.
  it('opens the tab named in the url, not the first one', async () => {
    wrapShell('/queues/status')
    // The tab strip itself reports which tab is live (aria-pressed), which is
    // the assertion that cannot pass by accident: "Status exceptions" also
    // appears as the card title below it.
    const statusTab = await screen.findByRole('button', { name: /status exceptions/i })
    expect(statusTab.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /^quarantine$/i }).getAttribute('aria-pressed')).toBe('false')
  })

  it('redirects a bare /queues to the first tab rather than rendering a tabless page', async () => {
    wrapShell('/queues')
    expect(await screen.findByRole('heading', { name: /^queues$/i })).toBeTruthy()
    expect(await screen.findByText(/show resolved rows/i)).toBeTruthy()
  })
})
