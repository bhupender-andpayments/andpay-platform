import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { ActivationBatchDevicesPage } from '../../src/features/activation/ActivationBatchDevicesPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'
import type { UnitInventoryRow } from '../../src/api/endpoints.js'

// The second step of the batch-first Activation drill-down (decision D8): a
// batch's devices, reached from the Activation tab, leading on into the
// existing device page in Inventory where manual activation lives. No new
// backend read: GET /ops/devices already carries `batch` and `activatedAt` per
// unit, so this page filters the roster the Inventory page already fetches.

function device(over: Partial<UnitInventoryRow> = {}): UnitInventoryRow {
  return {
    id: 'unit_1',
    deviceSerial: 'DEV-1',
    status: 'DELIVERED',
    activatedAt: null,
    productType: 'SOUNDBOX',
    manufacturerVndr: null,
    batch: 'btch_alpha',
    shipment: null,
    printedForMerchant: null,
    asgnId: 'asgn_1',
    location: null,
    simNo: '89910000000000000001',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location-probe">{location.pathname}</div>
}

function renderAt(btchId: string) {
  return render(
    <MemoryRouter
      initialEntries={[`/activation/batch/${btchId}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AuthProvider>
        <LocationProbe />
        <Routes>
          <Route path="/activation/batch/:btchId" element={<ActivationBatchDevicesPage />} />
          {/* Not rendered as a full page: this route only exists so navigating to
              it is observable, proving the drill-down leads to the SAME device
              page the rest of the portal uses rather than a second one. */}
          <Route path="/inventory/device/:unitId" element={<div>device page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('ActivationBatchDevicesPage', () => {
  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  it('shows only the devices belonging to THIS batch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([
          device({ id: 'unit_1', deviceSerial: 'DEV-1', batch: 'btch_alpha' }),
          device({ id: 'unit_2', deviceSerial: 'DEV-2', batch: 'btch_beta' }),
        ]),
      ),
    )
    renderAt('btch_alpha')
    expect(await screen.findByText('DEV-1')).toBeTruthy()
    expect(screen.queryByText('DEV-2')).toBeNull()
  })

  it('shows ACTIVATED for a device with an activation timestamp, plain text otherwise (decision D7)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([
          device({ id: 'unit_1', deviceSerial: 'DEV-1', activatedAt: '2026-08-10T00:00:00.000Z' }),
          device({ id: 'unit_2', deviceSerial: 'DEV-2', activatedAt: null }),
        ]),
      ),
    )
    renderAt('btch_alpha')
    await screen.findByText('DEV-1')
    expect(screen.getByText('Activated')).toBeTruthy()
    expect(screen.getByText('not activated')).toBeTruthy()
  })

  it('opens the existing Inventory device page on click, leading the drill-down on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([device({ id: 'unit_1', deviceSerial: 'DEV-1' })])))
    renderAt('btch_alpha')
    await userEvent.click(await screen.findByText('DEV-1'))
    // /inventory/device/:unitId, the SAME page the rest of the portal uses: this
    // step of the drill-down invents no second device screen of its own.
    expect(screen.getByTestId('location-probe').textContent).toBe('/inventory/device/unit_1')
  })

  it('says plainly when the batch has no devices, rather than an empty grid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([device({ batch: 'btch_other' })])))
    renderAt('btch_alpha')
    expect(await screen.findByText(/no devices found for this batch/i)).toBeTruthy()
  })
})
