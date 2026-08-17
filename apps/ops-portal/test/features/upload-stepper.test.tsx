import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { UPLOAD_KINDS, DEVICE_INVENTORY_KIND, kindBySlug } from '../../src/features/uploads/uploadKinds.js'

afterEach(() => { cleanup() })

describe('uploadKinds: the step honesty rules', () => {
  it('device inventory has NO review step and ends in Submit', () => {
    const steps = kindBySlug('device-inventory')!.steps.map((s) => s.key)
    expect(steps).toEqual(['choose', 'upload', 'submit'])
  })

  // The damage kind is GONE from this catalogue (D-25: no damage file
  // ingestion), so bank is now the kind that pins the four-step commit shape.
  it('bank ends in Commit, and the damage kind no longer exists', () => {
    expect(kindBySlug('bank')!.steps.map((s) => s.key)).toEqual(['choose', 'upload', 'review', 'commit'])
    expect(kindBySlug('damage')).toBeUndefined()
  })

  it('courier status has NO review step and ends in Submit', () => {
    expect(kindBySlug('courier-status')!.steps.map((s) => s.key)).toEqual(['choose', 'upload', 'submit'])
  })

  // The rule is NOT "device inventory is special", it is "state columns only
  // where the portal shares a real constant with the parser". Device inventory
  // and courier status both do; bank resolves its layout by source profile at
  // ingest, so listing columns for it would invent a contract the portal
  // cannot check.
  it('states columns ONLY where the portal shares a real constant with the parser', () => {
    const withColumns = UPLOAD_KINDS.filter((k) => k.columns !== undefined).map((k) => k.slug)
    // bank is the one absence, and it is the point of this test: its layout is
    // resolved by source profile at ingest, so naming columns for it would
    // invent a contract the portal cannot check.
    // 'damage' left the catalogue entirely on the damage workflow (D-25);
    // 'unit-status' left this list on 2026-08-14 with the bulk status-upload
    // page itself: the one manual status write left is a single-device
    // correction, made from the Inventory row it corrects.
    expect(withColumns.sort()).toEqual(['activation', 'courier-status', 'device-inventory', 'return'])
  })

  it('device inventory still states its one required column, from its own descriptor', () => {
    // The frozen rule left Device ID as the only required column, and the kind
    // that owns that claim moved out of the index rather than losing it.
    // The SHEET still carries three columns; only Device ID is required.
    expect(DEVICE_INVENTORY_KIND.columns).toEqual(['Device ID', 'Sim No', 'Device QR'])
    expect(DEVICE_INVENTORY_KIND.goodToKnow.some((g) => /required columns: device id/i.test(g))).toBe(true)
  })
})
