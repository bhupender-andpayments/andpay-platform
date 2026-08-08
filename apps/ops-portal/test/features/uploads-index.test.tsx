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
// Three equal choices are now three equal cards, each on its own route. No
// preselection, and each upload is linkable.
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

describe('Uploads index: three equal choices, none preselected', () => {
  it('offers all three uploads as links', () => {
    renderAt('/uploads')
    expect(screen.getByRole('link', { name: /bank request/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /damage report/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /device inventory/i })).toBeTruthy()
  })

  // The load-bearing assertion of this step. The old page rendered the bank
  // form on arrival, which is a choice made FOR the operator by tab ordering.
  it('renders NO upload form until one is chosen', () => {
    renderAt('/uploads')
    // Asserts on the form's own HEADING, not on a Preview button: those only
    // render once a file is staged, so a button assertion passed even against
    // the old tabbed page and proved nothing.
    expect(screen.queryByText(/bank request upload/i)).toBeNull()
    expect(screen.queryByText(/damage report upload/i)).toBeNull()
    expect(screen.queryByText(/device inventory upload/i)).toBeNull()
  })

  it('says who sends each file, so the operator knows which one they hold', () => {
    renderAt('/uploads')
    // getAllBy for the bank: two of the three files come FROM the bank, which
    // is itself the point of showing the source.
    expect(screen.getAllByText(/from the bank/i).length).toBe(2)
    expect(screen.getByText(/from the manufacturer/i)).toBeTruthy()
  })

  // Only the device inventory columns are stated. That list is a real constant
  // shared with the parser; the bank and damage layouts are selected by source
  // profile at ingest and the portal has no verified column list for them, so
  // it describes those files instead of inventing headers.
  it('states the device inventory columns up front', () => {
    renderAt('/uploads')
    expect(screen.getByText(/Device ID/)).toBeTruthy()
    expect(screen.getByText(/Sim No/)).toBeTruthy()
  })
})

describe('Uploads: each upload is its own linkable route', () => {
  it('opens the bank upload directly', async () => {
    renderAt('/uploads/bank')
    expect(await screen.findByText(/bank request upload/i)).toBeTruthy()
  })

  it('opens the damage upload directly', async () => {
    renderAt('/uploads/damage')
    expect(await screen.findByText(/damage report upload/i)).toBeTruthy()
  })

  it('opens the device inventory upload directly', async () => {
    renderAt('/uploads/device-inventory')
    expect(await screen.findByText(/device inventory upload/i)).toBeTruthy()
  })

  it('offers a way back to the other uploads', async () => {
    renderAt('/uploads/bank')
    expect(await screen.findByRole('link', { name: /all uploads/i })).toBeTruthy()
  })

  it('sends an unknown upload path back to the index rather than 404ing', () => {
    renderAt('/uploads/nonsense')
    expect(screen.getByRole('link', { name: /bank request/i })).toBeTruthy()
  })
})
