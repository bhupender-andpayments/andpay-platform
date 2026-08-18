import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { UploadsPage } from '../../src/features/uploads/UploadsPage.js'

// Redesign step 4 (13 Aug 2026) gave /uploads a catalogue of cards, one per
// kind. Task 10 (2026-08-18) RETIRES that catalogue: "the smart dropzone is
// its own page, not a card on the Uploads landing, and /uploads redirects to
// it." So bare /uploads, and every bookmark that used to land on the
// catalogue as an honest non-404 destination, now lands on the smart upload
// page instead (test/features/smart-upload.test.tsx covers that page's own
// behaviour). What survives here is the bookmark-safety property itself: an
// old or unknown /uploads/* path must still resolve to something real, not a
// dead end.
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

describe('Uploads: bare and unknown paths land on the smart upload page', () => {
  it('bare /uploads redirects to the smart upload page, not a card catalogue', async () => {
    renderAt('/uploads')
    expect(await screen.findByRole('heading', { name: /^upload a file$/i })).toBeTruthy()
  })

  // D-25: the damage upload no longer exists. The old bookmark must not 404
  // and must not resurrect a damage form; it lands on the smart page, the
  // same honest destination as any other unknown slug.
  it('sends the retired /uploads/damage bookmark to the smart upload page', async () => {
    renderAt('/uploads/damage')
    expect(await screen.findByRole('heading', { name: /^upload a file$/i })).toBeTruthy()
    expect(screen.queryByText(/damage report upload/i)).toBeNull()
  })

  it('sends an unknown upload path to the smart upload page rather than 404ing', async () => {
    renderAt('/uploads/nonsense')
    expect(await screen.findByRole('heading', { name: /^upload a file$/i })).toBeTruthy()
  })
})

describe('Uploads: each upload keeps its own linkable route', () => {
  // /uploads/bank RENDERS the bank ingest directly: it is not swallowed by
  // the smart-page redirect, because it is an explicit, addressable slug.
  it('deep-links the bank upload', async () => {
    renderAt('/uploads/bank')
    expect(await screen.findByText(/bank request upload/i)).toBeTruthy()
  })

  // Device inventory moved into the Inventory section (2026-08-12): the old
  // slug is a redirect for the same bookmark-must-not-404 reason as bank, and
  // it is unaffected by the smart-page redirect since it is matched first.
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
})
