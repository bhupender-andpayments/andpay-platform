import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
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

interface FetchCall {
  url: string
  init: RequestInit
}

/** A fetch stub that serves the device list on GET and lets the caller answer
 * anything else (activate-bulk) on top of it. Records every call so a test
 * can assert on what was actually sent. */
function stubDevicesAndActivate(devices: UnitInventoryRow[], onOther?: (url: string, init: RequestInit) => Response | undefined) {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init })
      const other = onOther?.(url, init)
      if (other !== undefined) return other
      return jsonResponse(devices)
    }),
  )
  return calls
}

function parseBody(call: FetchCall): { dispatchIds: string[] } {
  return JSON.parse(String(call.init.body)) as { dispatchIds: string[] }
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

// THE MULTISELECT (22 Aug 2026, the remaining small activation item). Row
// checkboxes are keyed at DISPATCH grain (asgnId), never device grain: this is
// the settled rule (TASKS_PRIORITIZED.md) that the in-screen action stays
// dispatch-grain even though the list renders one row per device.
describe('ActivationBatchDevicesPage: multiselect activation', () => {
  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  it('offers no per-row checkbox on an already-activated row, and disables select-all when nothing is activatable', async () => {
    stubDevicesAndActivate([
      device({ id: 'unit_1', deviceSerial: 'DEV-1', asgnId: 'asgn_1', activatedAt: '2026-08-10T00:00:00.000Z' }),
    ])
    renderAt('btch_alpha')
    await screen.findByText('DEV-1')
    // Only the header's select-all remains, and it is disabled: nothing on
    // this page could be checked into it.
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(1)
    expect((boxes[0] as HTMLButtonElement).disabled).toBe(true)
  })

  it('checking one device selects the whole dispatch, and shows the count and the Activate action', async () => {
    stubDevicesAndActivate([
      device({ id: 'unit_1', deviceSerial: 'DEV-1', asgnId: 'asgn_1' }),
      device({ id: 'unit_2', deviceSerial: 'DEV-2', asgnId: 'asgn_2' }),
    ])
    renderAt('btch_alpha')
    await screen.findByText('DEV-1')

    // Two data-row checkboxes plus the select-all in the header.
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(3)
    await userEvent.click(screen.getByRole('checkbox', { name: /select dev-1/i }))

    expect(await screen.findByText('1 dispatch selected')).toBeTruthy()
    expect(screen.getByRole('button', { name: /activate selected/i })).toBeTruthy()
  })

  it('select-all picks every activatable dispatch and skips the already-activated one', async () => {
    stubDevicesAndActivate([
      device({ id: 'unit_1', deviceSerial: 'DEV-1', asgnId: 'asgn_1' }),
      device({ id: 'unit_2', deviceSerial: 'DEV-2', asgnId: 'asgn_2' }),
      device({ id: 'unit_3', deviceSerial: 'DEV-3', asgnId: 'asgn_3', activatedAt: '2026-08-10T00:00:00.000Z' }),
    ])
    renderAt('btch_alpha')
    await screen.findByText('DEV-1')
    await userEvent.click(screen.getByRole('checkbox', { name: /select all activatable devices/i }))
    expect(await screen.findByText('2 dispatches selected')).toBeTruthy()
  })

  it('activating posts exactly the selected dispatch ids, only after confirming, and reports the count', async () => {
    const calls = stubDevicesAndActivate(
      [
        device({ id: 'unit_1', deviceSerial: 'DEV-1', asgnId: 'asgn_1' }),
        device({ id: 'unit_2', deviceSerial: 'DEV-2', asgnId: 'asgn_2' }),
      ],
      (url) =>
        url.includes('/activate-bulk')
          ? jsonResponse({
              results: [
                { dispatchId: 'asgn_1', activated: true, reason: null },
              ],
            })
          : undefined,
    )
    renderAt('btch_alpha')
    await screen.findByText('DEV-1')
    await userEvent.click(screen.getByRole('checkbox', { name: /select dev-1/i }))
    await userEvent.click(await screen.findByRole('button', { name: /activate selected/i }))

    // The first click only asks: nothing posted yet.
    expect(calls.some((c) => c.url.includes('/activate-bulk'))).toBe(false)
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^activate$/i }))

    const write = await vi.waitFor(() => {
      const found = calls.find((c) => c.url.includes('/activate-bulk'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(parseBody(write).dispatchIds).toEqual(['asgn_1'])
    // asgn_2 was never checked, so it is not in the write, even though it is
    // activatable and appears in the same batch.
    expect(await screen.findByText('1 device activated')).toBeTruthy()
  })
})
