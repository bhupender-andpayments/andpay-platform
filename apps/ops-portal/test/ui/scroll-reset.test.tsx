import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, Link } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { AppShell } from '../../src/ui/AppShell.js'

// EVERY ROUTE OPENS AT THE TOP.
//
// A client-side navigation never reloads the document, so the scroll position
// simply survives it: scrolling to the bottom of a long Inventory table and
// clicking Batches landed halfway down the new page.
//
// The reset has to target the shell's <main>, which is the only scrolling
// element (the shell is h-screen overflow-hidden). window.scrollTo, and
// react-router's own ScrollRestoration which drives the window, would both run
// here and do exactly nothing.

afterEach(() => { cleanup() })

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/inventory']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <AppShell>
          <Routes>
            <Route
              path="/inventory"
              element={
                <div>
                  <p>inventory page</p>
                  <Link to="/batches">go to batches</Link>
                  <Link to="/inventory?status=IN_STOCK">filter in place</Link>
                </div>
              }
            />
            <Route path="/batches" element={<p>batches page</p>} />
          </Routes>
        </AppShell>
      </AuthProvider>
    </MemoryRouter>,
  )
}

/**
 * The shell's scrolling element, scrolled down, with a readable/writable
 * scrollTop standing in for the one jsdom cannot give us (it has no layout, so
 * its own scrollTop is permanently 0 and assignment to it is a no-op).
 */
function scrolledMain(startAt = 500): { read(): number } {
  const main = document.querySelector('main')
  if (main === null) throw new Error('the shell rendered no <main>')
  let value = startAt
  Object.defineProperty(main, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      value = next
    },
  })
  return { read: () => value }
}

describe('AppShell scroll reset', () => {
  it('scrolls the shell back to the top when the route changes', async () => {
    renderShell()
    const main = scrolledMain(500)

    await userEvent.click(screen.getByRole('link', { name: /go to batches/i }))

    expect(await screen.findByText('batches page')).toBeTruthy()
    expect(main.read()).toBe(0)
  })

  it('does NOT reset when only the query string changes', async () => {
    // Filters, pagination and status chips all live in the query string across
    // this portal. Resetting on those would yank the page to the top every time
    // an operator ticked a filter under the table they were reading.
    renderShell()
    const main = scrolledMain(500)

    await userEvent.click(screen.getByRole('link', { name: /filter in place/i }))

    expect(screen.getByText('inventory page')).toBeTruthy()
    expect(main.read()).toBe(500)
  })
})
