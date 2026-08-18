import { describe, expect, it } from 'vitest'
import { buildSampleReturnSheet, type SampleReturnSource } from '../../src/features/uploads/sampleReturnSheet.js'
import type { BatchEntryRow } from '../../src/api/endpoints.js'

// The return sample is the one generator whose output depends on live state, so
// these tests pin the RULES it applies to that state. Each assertion maps to a
// quarantine reason in services/fulfillment/src/return-sheet.ts: get one wrong
// and the demo uploads a sheet that lands in the intake exceptions queue.
//
// REWRITTEN 18 Aug 2026, at the user's correction. The generator used to put
// every soundbox row on ONE AWB and every collateral row on a SECOND, which is
// not how parcels actually travel: a 10-dispatch batch produced exactly 2
// shipments, and the Shipments tab looked broken. It now returns TWO FILES
// (one per delivery group, mirroring the two vendor Excels) with ONE AWB PER
// ROW, and nothing caps how much of the batch a file covers.

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
  it('gives every SOUNDBOX row a serial and every COLLATERAL row none, each in its own file', () => {
    // The W-5 gates bite in BOTH directions: a soundbox row without a serial is
    // device_required_for_soundbox, a collateral row WITH one is
    // unexpected_device_for_collateral. This is the assertion that matters most.
    const out = buildSampleReturnSheet(source())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const { soundbox, collateral } = out.file
    expect(soundbox).not.toBeNull()
    expect(collateral).not.toBeNull()
    for (const r of rows(soundbox!.csv)) expect(r[1]).not.toBe('')
    for (const r of rows(collateral!.csv)) expect(r[1]).toBe('')
    expect(soundbox!.rows).toBe(2)
    expect(collateral!.rows).toBe(1)
  })

  it('never reuses a serial and never exceeds the free ones', () => {
    // A serial used twice would pair one unit and quarantine the next as
    // unit_already_paired, inside a single file.
    const out = buildSampleReturnSheet(
      source({ entries: [...source().entries, entry({ asgnId: 'asgn_s3' })] }),
    )
    if (!out.ok) throw new Error('expected a file')
    const serials = rows(out.file.soundbox!.csv)
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
    expect(out.file.soundbox!.csv).toContain('asgn_live')
    expect(out.file.soundbox!.csv).not.toContain('asgn_done')
  })

  it('skips legacy rows with no dispatch group rather than guessing', () => {
    const out = buildSampleReturnSheet(
      source({ entries: [entry({ asgnId: 'asgn_legacy', dispatchGroup: null }), entry({ asgnId: 'asgn_ok' })] }),
    )
    if (!out.ok) throw new Error('expected a file')
    expect(out.file.soundbox!.csv).not.toContain('asgn_legacy')
  })

  it('omits the Courier column entirely when no active courier is known', () => {
    // Absent is safe; an unrecognised code is unknown_courier. Never invent one.
    const out = buildSampleReturnSheet(source({ courierCode: null }))
    if (!out.ok) throw new Error('expected a file')
    expect(out.file.soundbox!.csv.split('\n')[0]).toBe('Dispatch ID,Device ID,AWB')
    expect(out.file.collateral!.csv.split('\n')[0]).toBe('Dispatch ID,Device ID,AWB')
  })

  it('carries the courier code on every row when one is supplied, in both files', () => {
    const out = buildSampleReturnSheet(source({ courierCode: 'BDE' }))
    if (!out.ok) throw new Error('expected a file')
    expect(out.file.soundbox!.csv.split('\n')[0]).toBe('Dispatch ID,Device ID,AWB,Courier')
    for (const r of rows(out.file.soundbox!.csv)) expect(r[3]).toBe('BDE')
    for (const r of rows(out.file.collateral!.csv)) expect(r[3]).toBe('BDE')
  })

  it('gives every row its own AWB, never shared, fresh per download', () => {
    // One AWB is one shipment: the ingest dedups shpt birth on the AWB, so two
    // dispatches sharing one would land on the SAME shipment record instead of
    // travelling as the separate parcels they are.
    const first = buildSampleReturnSheet(source(), new Date(1786000000000), 5)
    const second = buildSampleReturnSheet(source(), new Date(1786000041000), 5)
    if (!first.ok || !second.ok) throw new Error('expected files')
    const firstAwbs = [...first.file.soundbox!.awbs, ...first.file.collateral!.awbs]
    const secondAwbs = [...second.file.soundbox!.awbs, ...second.file.collateral!.awbs]
    // 2 soundbox rows + 1 collateral row = 3 rows, 3 distinct AWBs.
    expect(new Set(firstAwbs).size).toBe(3)
    for (const awb of secondAwbs) expect(firstAwbs).not.toContain(awb)
  })

  it('covers the whole batch, not a capped sample of it', () => {
    // The old generator capped at 6 soundbox / 4 collateral rows and silently
    // dropped the rest, which is exactly what left a larger batch's Shipments
    // tab looking incomplete.
    const manySoundbox = Array.from({ length: 9 }, (_, i) => entry({ asgnId: `asgn_sb_${i}` }))
    const manyCollateral = Array.from({ length: 7 }, (_, i) =>
      entry({ asgnId: `asgn_co_${i}`, dispatchGroup: 'COLLATERAL', soundbox: false }),
    )
    const out = buildSampleReturnSheet(
      source({
        entries: [...manySoundbox, ...manyCollateral],
        freeSerials: Array.from({ length: 9 }, (_, i) => `90000000000${i}`),
      }),
    )
    if (!out.ok) throw new Error('expected a file')
    expect(out.file.soundbox!.rows).toBe(9)
    expect(out.file.collateral!.rows).toBe(7)
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

  // The "picks the newest batch with a print vendor bound" test went with
  // selectSampleReturnBatch itself (18 Aug 2026): choosing a batch on the
  // operator's behalf is exactly the behaviour that was wrong, so there is no
  // selection left to pin. The batch is always passed in by the caller now.

  it('names the batch in both filenames, so two batches cannot be confused in a downloads folder', () => {
    const out = buildSampleReturnSheet(source({ batchId: 'btch_xyz' }))
    if (!out.ok) throw new Error('expected files')
    expect(out.file.batchId).toBe('btch_xyz')
    expect(out.file.soundbox!.filename).toBe('btch_xyz-return-soundbox.csv')
    expect(out.file.collateral!.filename).toBe('btch_xyz-return-collateral.csv')
  })
})
