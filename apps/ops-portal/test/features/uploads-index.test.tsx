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
// Three equal choices became three equal cards, each on its own route. As of
// 13 Aug 2026 the index is the CATALOGUE of every file the platform ingests,
// including the two whose pages another section owns (device inventory and the
// status correction, both under /inventory): listing is not owning, and those
// cards navigate to the owning route.
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

describe('Uploads step 1: the remaining choice, none preselected', () => {
  // THE CATALOGUE (13 Aug 2026): every file the platform ingests is offered
  // here, including the two whose pages another section owns. The card for one
  // of those navigates to the owning route rather than duplicating the page,
  // which is what keeps "listed" from becoming "a second entry point".
  it('offers every upload kind as a link', () => {
    renderAt('/uploads')
    // FIVE cards since the damage workflow (D-25): damage is no longer a file
    // anyone sends, so no card here may claim one exists. Exactly these five.
    for (const name of [
      /bank requests/i,
      /device inventory/i,
      /print vendor return/i,
      /courier statuses/i,
      /cwd activation results/i,
    ]) {
      expect(screen.getByRole('link', { name })).toBeTruthy()
    }
    // The retired kind: no damage card, in any spelling.
    expect(screen.queryByText(/damage report/i)).toBeNull()
  })

  it('points the kind another section owns at that section, not at a copy here', () => {
    renderAt('/uploads')
    expect(screen.getByRole('link', { name: /device inventory/i }).getAttribute('href')).toBe('/inventory/upload')
  })

  // THE load-bearing assertion, carried over from the tabs-era fix: arriving
  // at /uploads renders NO upload form. A rail that preselected a type would
  // remake the documented defect where an operator with an inventory file
  // landed on a bank form.
  it('renders NO upload form until one is chosen', () => {
    renderAt('/uploads')
    expect(screen.queryByText(/bank request upload/i)).toBeNull()
    expect(screen.queryByText(/device inventory upload/i)).toBeNull()
  })

  it('shows no step rail on the index: six equal cards, nothing preselected', () => {
    // The replicated index has no stepper (the pdf original had none); each
    // sub-page renders its own rail. What must NOT appear is any step name
    // asserting a flow before a file type exists.
    renderAt('/uploads')
    expect(screen.queryByText(/choose file/i)).toBeNull()
    expect(screen.queryByText(/^review$/i)).toBeNull()
    expect(screen.queryByText(/^commit$/i)).toBeNull()
    expect(screen.queryByText(/^submit$/i)).toBeNull()
  })

  it('says who sends the file, so the operator knows which one they hold', () => {
    renderAt('/uploads')
    // ONE bank line since D-25: the request file. The damage report card that
    // shared this source is gone with damage file ingestion itself.
    expect(screen.getAllByText(/from the bank/i).length).toBe(1)
    expect(screen.getByText(/from the manufacturer/i)).toBeTruthy()
    expect(screen.getByText(/from the print vendor/i)).toBeTruthy()
    expect(screen.getByText(/from the courier/i)).toBeTruthy()
    expect(screen.getByText(/^from cwd$/i)).toBeTruthy()
  })

  it('states the required columns up front for the kinds that can name them', () => {
    renderAt('/uploads')
    // Bank and damage name none, because their layout is resolved by source
    // profile at ingest and the portal has no constant to state. The other four
    // can: device inventory, return, courier statuses, activation.
    const stated = screen.getAllByText(/required columns:/i).map((el) => el.textContent)
    expect(stated).toHaveLength(4)
    expect(stated.some((t) => /required columns: awb, status, status date$/i.test(t ?? ''))).toBe(true)
    expect(stated.some((t) => /required columns: device id, status$/i.test(t ?? ''))).toBe(true)
  })
})

describe('Uploads: each upload keeps its own linkable route', () => {
  // The bank flow now lives in the workflow workspace, so this url is a
  // redirect. It must not 404 and must not land on the uploads index: a
  // bookmark or a runbook link has to arrive somewhere true.
  //
  // /uploads/bank RENDERS the bank ingest again as of 13 Aug 2026. It used to
  // redirect into the Workflow workspace, which owned the bank flow; that
  // workspace is gone and the flow is back where the file arrives.
  it('deep-links the bank upload', async () => {
    renderAt('/uploads/bank')
    expect(await screen.findByText(/bank request upload/i)).toBeTruthy()
  })
  // D-25: the damage upload no longer exists, so its old bookmark lands on
  // the index (the honest destination) rather than a 404 or a dead form.
  it('sends the retired /uploads/damage bookmark back to the index', async () => {
    renderAt('/uploads/damage')
    expect(await screen.findByRole('link', { name: /bank requests/i })).toBeTruthy()
    expect(screen.queryByText(/damage report upload/i)).toBeNull()
  })
  // Device inventory moved into the Inventory section (2026-08-12): the old
  // slug is a redirect for the same bookmark-must-not-404 reason as bank.
  // Sentinel target, same rationale as above.
  it('redirects /uploads/device-inventory into the Inventory section', async () => {
    render(
      <MemoryRouter
        initialEntries={['/uploads/device-inventory']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          <Routes>
            <Route path="/uploads/*" element={<UploadsPage />} />
            <Route path="/inventory/upload" element={<div>inventory upload home</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(screen.queryByText(/device inventory upload/i)).toBeNull()
    expect(await screen.findByText(/inventory upload home/i)).toBeTruthy()
  })
  it('sends an unknown upload path back to step 1 rather than 404ing', () => {
    renderAt('/uploads/nonsense')
    expect(screen.getByRole('link', { name: /print vendor return/i })).toBeTruthy()
  })
})
