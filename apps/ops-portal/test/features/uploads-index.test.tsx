import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { UploadsPage } from '../../src/features/uploads/UploadsPage.js'

// Redesign step 4. Uploads was three TABS with "Bank Requests" selected by
// default. Two problems with that, and the default is the worse one:
//
//   1. An operator arriving to upload a device inventory file lands on a bank
//      request form. Nothing says the other two exist until they notice tabs.
//   2. There is no way to link someone to "the damage upload". Every upload
//      shares one URL.
//
// Three equal choices became three equal cards, each on its own route. The
// 2026-08-11 ruling keeps both fixes and turns the remaining cards into step 1
// of one continuous flow with a numbered step rail, instead of a page an
// operator drills into and backs out of. The SAME 2026-08-11 ruling also moves
// the bank upload out of here entirely: it is now stages 1 and 2 of the
// workflow workspace, so /uploads offers only damage reports and device
// inventory, and /uploads/bank redirects into the workspace.
afterEach(() => { cleanup() })

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/uploads/*" element={<UploadsPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('Uploads step 1: two equal choices, none preselected', () => {
  it('offers the two remaining uploads as links', () => {
    renderAt('/uploads')
    expect(screen.getByRole('link', { name: /damage report/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /device inventory/i })).toBeTruthy()
  })

  // THE load-bearing assertion, carried over from the tabs-era fix: arriving
  // at /uploads renders NO upload form. A rail that preselected a type would
  // remake the documented defect where an operator with an inventory file
  // landed on a bank form.
  it('renders NO upload form until one is chosen', () => {
    renderAt('/uploads')
    expect(screen.queryByText(/bank request upload/i)).toBeNull()
    expect(screen.queryByText(/damage report upload/i)).toBeNull()
    expect(screen.queryByText(/device inventory upload/i)).toBeNull()
  })

  it('shows the rail at step 1, and does NOT assert Review or Commit before a type exists', () => {
    renderAt('/uploads')
    expect(screen.getByText(/choose file/i)).toBeTruthy()
    // The index rail is Choose file plus Upload only: whether Review and
    // Commit or Submit exist depends on the file, which is not chosen yet.
    expect(screen.queryByText(/^review$/i)).toBeNull()
    expect(screen.queryByText(/^commit$/i)).toBeNull()
    expect(screen.queryByText(/^submit$/i)).toBeNull()
  })

  // Bank moved to the workflow workspace (2026-08-11 ruling), so the only
  // remaining "From the bank" source line is damage's own "From the bank,
  // after delivery".
  it('says who sends each file, so the operator knows which one they hold', () => {
    renderAt('/uploads')
    expect(screen.getAllByText(/from the bank/i).length).toBe(1)
    expect(screen.getByText(/from the manufacturer/i)).toBeTruthy()
  })

  it('states the required columns up front for the two kinds that can name them', () => {
    renderAt('/uploads')
    // Device ID is device inventory's only required column since the 12 Aug 2026
    // walkthrough (Workflow A frozen rule); Sim No and Device QR are optional.
    // Courier status requires all three of its own, because there is no useful
    // partial row there. Bank and damage name none: their layout is resolved by
    // source profile at ingest, so the portal has no constant to state.
    const stated = screen.getAllByText(/required columns:/i).map((el) => el.textContent)
    expect(stated).toHaveLength(2)
    expect(stated.some((t) => /required columns: device id$/i.test(t ?? ''))).toBe(true)
    expect(stated.some((t) => /required columns: awb, status, status date$/i.test(t ?? ''))).toBe(true)
  })
})

describe('Uploads: each upload keeps its own linkable route', () => {
  // The bank flow now lives in the workflow workspace, so this url is a
  // redirect. It must not 404 and must not land on the uploads index: a
  // bookmark or a runbook link has to arrive somewhere true.
  //
  // The workspace route is a SENTINEL here, not the real WorkflowPage. What is
  // under test is the redirect TARGET, and mounting the real page would drag its
  // four mount-time reads into a suite that stubs no network at all, so a
  // failure would stop being about upload routing. The real page rendering at
  // /workflow is pinned in routes.test.tsx and portal-smoke.test.tsx.
  it('redirects /uploads/bank into the workflow workspace', async () => {
    render(
      <MemoryRouter initialEntries={['/uploads/bank']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <Routes>
            <Route path="/uploads/*" element={<UploadsPage />} />
            <Route path="/workflow" element={<div>workflow workspace</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(screen.queryByText(/bank request upload/i)).toBeNull()
    expect(await screen.findByText(/workflow workspace/i)).toBeTruthy()
  })
  it('deep-links the damage upload', async () => {
    renderAt('/uploads/damage')
    expect(await screen.findByText(/damage report upload/i)).toBeTruthy()
  })
  it('deep-links the device inventory upload', async () => {
    renderAt('/uploads/device-inventory')
    expect(await screen.findByText(/device inventory upload/i)).toBeTruthy()
  })
  it('sends an unknown upload path back to step 1 rather than 404ing', () => {
    renderAt('/uploads/nonsense')
    expect(screen.getByRole('link', { name: /damage report/i })).toBeTruthy()
  })
})
