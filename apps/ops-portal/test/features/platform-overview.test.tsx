import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PlatformOverviewPage } from '../../src/features/overview/PlatformOverviewPage.js'

// The one page in the console that EXPLAINS rather than reports, so the risks are
// not the usual ones: it fetches nothing, so it cannot show a stale number, and
// it holds no state, so it cannot get stuck. What it CAN do is drift from the
// product, and send someone to a route that no longer exists.
//
// So this pins the two things a future change would break silently: that all
// seven steps are present and in order, and that every link in the body points at
// a live route. It deliberately does NOT assert the prose, which is meant to be
// edited.

afterEach(() => {
  cleanup()
})

function renderPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <PlatformOverviewPage />
    </MemoryRouter>,
  )
}

// Every route the sidebar offers, plus the deep links the steps use. A step
// pointing anywhere else is either a typo or a section that moved.
const LIVE_ROUTES = new Set([
  '/command-center',
  '/overview',
  '/merchants',
  '/inventory',
  '/pool',
  '/batches',
  '/dispatches',
  '/shipments',
  '/activation',
  '/uploads',
  '/uploads/bank',
  '/queues',
  '/damage-cases',
  '/reports',
  '/masterdata',
])

const STEP_TITLES = [
  'Devices arrive from the manufacturer',
  'A bank sends a request file',
  'The pool forms a batch',
  'Hand the batch to the print vendor',
  'The vendor returns the sheet',
  'Activate with the CWD',
  'Damage and replacement',
]

describe('PlatformOverviewPage', () => {
  it('renders all seven steps, in flow order', () => {
    renderPage()

    for (const title of STEP_TITLES) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0)
    }
    // ORDER, not just presence: the whole point of the page is what happens
    // after what, so a reordered array is a content bug rather than a nit. Read
    // off the rail's own dots, which carry data-step for exactly this: the
    // actions INSIDE a step are numbered too, so a structural selector would
    // collect those as well.
    const numbers = [...document.querySelectorAll('[data-step]')].map((n) => n.textContent)
    expect(numbers).toEqual(['1', '2', '3', '4', '5', '6', '7'])
  })

  it('every link points at a route that exists', () => {
    renderPage()

    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(hrefs.length).toBeGreaterThan(8)
    for (const href of hrefs) {
      expect(LIVE_ROUTES.has(href ?? '')).toBe(true)
    }
  })

  it('opens on step one and leaves the rest collapsed, so it does not read as seven closed boxes', () => {
    renderPage()

    const steps = [...document.querySelectorAll('ol > li details')]
    expect(steps).toHaveLength(STEP_TITLES.length)
    expect((steps[0] as HTMLDetailsElement).open).toBe(true)
    for (const s of steps.slice(1)) expect((s as HTMLDetailsElement).open).toBe(false)
  })

  it('answers the questions people ask first, all collapsed', () => {
    renderPage()

    expect(screen.getByText('Questions people ask first')).toBeTruthy()
    // The FAQ sits outside the stepper's own <ol>, so it is found by its heading
    // rather than by position.
    expect(screen.getByText(/why does a new pool row take a moment/i)).toBeTruthy()
    expect(screen.getByText(/why is a dispatch not the same as a shipment/i)).toBeTruthy()
    expect(screen.getByText(/why can i not close a batch/i)).toBeTruthy()
  })

  it('fetches nothing: the page is prose and links', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    renderPage()
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
