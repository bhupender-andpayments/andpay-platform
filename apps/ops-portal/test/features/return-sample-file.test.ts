import { describe, expect, it } from 'vitest'
import {
  buildSampleReturnSheet,
  selectSampleReturnBatch,
  type SampleReturnSource,
} from '../../src/features/uploads/sampleReturnSheet.js'
import type { BatchEntryRow } from '../../src/api/endpoints.js'

// The return sample is the one generator whose output depends on live state, so
// these tests pin the RULES it applies to that state. Each assertion maps to a
// quarantine reason in services/fulfillment/src/return-sheet.ts: get one wrong
// and the demo uploads a sheet that lands in the intake exceptions queue.

function entry(over: Partial<BatchEntryRow> & { asgnId: string }): BatchEntryRow {
  return {
    merchantDisplayName: 'A MERCHANT',
    merchantLegalName: 'A MERCHANT LLP',
    bankReferenceCode: '3',
    bankDisplayName: 'GSCB',
    branchCode: '30',
    soundbox: true,
    standeeCount: 1,
    stickerCount: 2,
    poolStatus: 'BATCHED',
    dispatchState: 'SENT_TO_VENDOR',
    shipToSuperseded: false,
    dispatchGroup: 'SOUNDBOX',
    ...over,
  }
}

function source(over: Partial<SampleReturnSource> = {}): SampleReturnSource {
  return {
    batchId: 'btch_test',
    entries: [
      entry({ asgnId: 'asgn_s1', dispatchGroup: 'SOUNDBOX' }),
      entry({ asgnId: 'asgn_s2', dispatchGroup: 'SOUNDBOX' }),
      entry({ asgnId: 'asgn_c1', dispatchGroup: 'COLLATERAL', soundbox: false }),
    ],
    freeSerials: ['900000000001', '900000000002'],
    courierCode: null,
    ...over,
  }
}

function rows(csv: string): string[][] {
  return csv
    .trimEnd()
    .split('\n')
    .slice(1)
    .map((l) => l.split(','))
}

describe('sample return sheet (testing aid)', () => {
  it('gives every SOUNDBOX row a serial and every COLLATERAL row none', () => {
    // The W-5 gates bite in BOTH directions: a soundbox row without a serial is
    // device_required_for_soundbox, a collateral row WITH one is
    // unexpected_device_for_collateral. This is the assertion that matters most.
    const out = buildSampleReturnSheet(source())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const parsed = rows(out.file.csv)
    const soundbox = parsed.slice(0, out.file.soundboxRows)
    const collateral = parsed.slice(out.file.soundboxRows)
    for (const r of soundbox) expect(r[1]).not.toBe('')
    for (const r of collateral) expect(r[1]).toBe('')
    expect(out.file.soundboxRows).toBe(2)
    expect(out.file.collateralRows).toBe(1)
  })

  it('never reuses a serial and never exceeds the free ones', () => {
    // A serial used twice would pair one unit and quarantine the next as
    // unit_already_paired, inside a single file.
    const out = buildSampleReturnSheet(
      source({ entries: [...source().entries, entry({ asgnId: 'asgn_s3' })] }),
    )
    if (!out.ok) throw new Error('expected a file')
    const serials = rows(out.file.csv)
      .map((r) => r[1])
      .filter((s) => s !== '')
    expect(new Set(serials).size).toBe(serials.length)
    expect(serials.length).toBeLessThanOrEqual(2)
  })

  it('skips entries that are not awaiting their vendor', () => {
    // A dispatch already returned has moved on; naming it again would attach a
    // second shipment to a leg that already has one.
    const out = buildSampleReturnSheet(
      source({
        entries: [
          entry({ asgnId: 'asgn_done', dispatchState: 'DISPATCHED_BY_VENDOR' }),
          entry({ asgnId: 'asgn_live' }),
        ],
      }),
    )
    if (!out.ok) throw new Error('expected a file')
    expect(out.file.csv).toContain('asgn_live')
    expect(out.file.csv).not.toContain('asgn_done')
  })

  it('skips legacy rows with no dispatch group rather than guessing', () => {
    const out = buildSampleReturnSheet(
      source({ entries: [entry({ asgnId: 'asgn_legacy', dispatchGroup: null }), entry({ asgnId: 'asgn_ok' })] }),
    )
    if (!out.ok) throw new Error('expected a file')
    expect(out.file.csv).not.toContain('asgn_legacy')
  })

  it('omits the Courier column entirely when no active courier is known', () => {
    // Absent is safe; an unrecognised code is unknown_courier. Never invent one.
    const out = buildSampleReturnSheet(source({ courierCode: null }))
    if (!out.ok) throw new Error('expected a file')
    expect(out.file.csv.split('\n')[0]).toBe('Dispatch ID,Device ID,AWB')
  })

  it('carries the courier code on every row when one is supplied', () => {
    const out = buildSampleReturnSheet(source({ courierCode: 'BDE' }))
    if (!out.ok) throw new Error('expected a file')
    expect(out.file.csv.split('\n')[0]).toBe('Dispatch ID,Device ID,AWB,Courier')
    for (const r of rows(out.file.csv)) expect(r[3]).toBe('BDE')
  })

  it('groups the two legs onto two different AWBs, fresh per download', () => {
    // One AWB is one shipment: the ingest dedups shpt birth on the AWB, so a
    // reused one would attach today's rows to an earlier shipment.
    const first = buildSampleReturnSheet(source(), new Date(1786000000000), 5)
    const second = buildSampleReturnSheet(source(), new Date(1786000041000), 5)
    if (!first.ok || !second.ok) throw new Error('expected files')
    expect(new Set(first.file.awbs).size).toBe(2)
    for (const awb of second.file.awbs) expect(first.file.awbs).not.toContain(awb)
  })

  it('explains itself when nothing is eligible, rather than emitting a bad file', () => {
    const returned = buildSampleReturnSheet(
      source({ entries: [entry({ asgnId: 'asgn_x', dispatchState: 'DISPATCHED_BY_VENDOR' })] }),
    )
    expect(returned.ok).toBe(false)
    if (returned.ok) return
    expect(returned.problem).toContain('already been returned')

    const noDevices = buildSampleReturnSheet(
      source({ entries: [entry({ asgnId: 'asgn_s1' })], freeSerials: [] }),
    )
    expect(noDevices.ok).toBe(false)
    if (noDevices.ok) return
    expect(noDevices.problem).toContain('no unpaired devices')
  })

  it('picks the newest batch that has a print vendor bound', () => {
    // A batch with no vendor is refused whole as batch_has_no_vendor, so it must
    // never be the one a sample is built from.
    const picked = selectSampleReturnBatch([
      { id: 'old', printVndr: 'vndr_1', createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'newest-no-vendor', printVndr: null, createdAt: '2026-08-16T00:00:00.000Z' },
      { id: 'newest-with-vendor', printVndr: 'vndr_2', createdAt: '2026-08-10T00:00:00.000Z' },
    ])
    expect(picked?.id).toBe('newest-with-vendor')
    expect(selectSampleReturnBatch([{ id: 'x', printVndr: null, createdAt: '2026-08-01T00:00:00.000Z' }])).toBeNull()
  })
})
