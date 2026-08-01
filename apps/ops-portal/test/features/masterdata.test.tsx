import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { VendorRegistryPage } from '../../src/features/masterdata/VendorRegistryPage.js'
import { CourierMasterPage } from '../../src/features/masterdata/CourierMasterPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The confirmed edge contract (apps/ops-edge/src/ops-read.controller.ts,
// grounded against services/fulfillment/src/ops-read.ts's listVendors /
// VendorRow): GET /ops/vendors -> VendorRow[], a platform-only (no program
// scope) registry of ALL vendor types (MANUFACTURER | PRINT | COURIER). The
// courier master is not a separate route: it is this same list filtered
// client-side to type === 'COURIER'.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const MIXED_VENDORS = [
  {
    id: 'v-1',
    type: 'MANUFACTURER',
    displayName: 'Acme Devices',
    status: 'ACTIVE',
    courierCode: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  },
  {
    id: 'v-2',
    type: 'PRINT',
    displayName: 'Print Co',
    status: 'ACTIVE',
    courierCode: null,
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
  },
  {
    id: 'v-3',
    type: 'COURIER',
    displayName: 'Speedy Couriers',
    status: 'ACTIVE',
    courierCode: 'SPD',
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
  },
]

describe('master data views', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('VendorRegistryPage lists ALL vendors regardless of type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(MIXED_VENDORS)
        return jsonResponse([])
      }),
    )

    render(
      <MemoryRouter>
        <AuthProvider>
          <VendorRegistryPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Acme Devices')).toBeTruthy()
    expect(screen.getByText('Print Co')).toBeTruthy()
    expect(screen.getByText('Speedy Couriers')).toBeTruthy()
    expect(screen.getByText('MANUFACTURER')).toBeTruthy()
    expect(screen.getByText('PRINT')).toBeTruthy()
    expect(screen.getByText('COURIER')).toBeTruthy()
    expect(screen.getByText('SPD')).toBeTruthy()
    // Two of the three rows have a null courierCode: rendered as a dash, never
    // the literal string "null".
    expect(screen.queryByText('null')).toBeNull()
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(2)
  })

  it('CourierMasterPage shows ONLY type===COURIER rows and hides MANUFACTURER/PRINT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(MIXED_VENDORS)
        return jsonResponse([])
      }),
    )

    render(
      <MemoryRouter>
        <AuthProvider>
          <CourierMasterPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Speedy Couriers')).toBeTruthy()
    expect(screen.getByText('SPD')).toBeTruthy()
    expect(screen.queryByText('Acme Devices')).toBeNull()
    expect(screen.queryByText('Print Co')).toBeNull()
    expect(screen.queryByText('MANUFACTURER')).toBeNull()
    expect(screen.queryByText('PRINT')).toBeNull()
  })
})
