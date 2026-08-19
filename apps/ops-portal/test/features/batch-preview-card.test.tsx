import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { BatchPreviewCard, summarisePool } from '../../src/features/fulfillment/BatchPreviewCard.js'
import type { PoolEntryRow } from '../../src/api/endpoints.js'

// What the next batch would contain, beside the pool it summarises. It exists
// because the pool table came out from behind its "View pool" dialog and the
// space that freed up is worth a straight answer to "so what am I about to
// create".
//
// Every figure is derived in TypeScript from rows already fetched for display,
// the same posture BatchablePools states for its own counts (architecture.test
// forbids aggregates in ops-read.ts).

function entry(over: Partial<PoolEntryRow> = {}): PoolEntryRow {
  return {
    asgnId: 'asgn_1',
    dispatchGroup: null,
    replacementRaised: false,
    merchantDisplayName: 'BRILLIANT PERFUME',
    merchantLegalName: 'BRILLIANT PERFUME',
    bankReferenceCode: '3',
    bankDisplayName: 'GSCB',
    branchCode: '30',
    soundbox: true,
    standeeCount: 1,
    stickerCount: 2,
    poolStatus: 'POOLED',
    dispatchState: null,
    shipToSuperseded: false,
    batch: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    tenantId: 'tnnt_1',
    programId: 'prg_1',
    ...over,
  }
}

afterEach(() => {
  cleanup()
})

describe('summarisePool', () => {
  it('counts banks on the AGGREGATOR CODE, not the display name', () => {
    // D7 leaves bank_display_name as the partner ("GSCB") on every row while the
    // aggregator code differs, so counting names reports 1 bank for a pool
    // spanning many. groupBatchablePools carries the same note for the same
    // reason; this is the trap, pinned.
    const s = summarisePool([
      entry({ asgnId: 'a', bankReferenceCode: '3', bankDisplayName: 'GSCB' }),
      entry({ asgnId: 'b', bankReferenceCode: '7', bankDisplayName: 'GSCB' }),
      entry({ asgnId: 'c', bankReferenceCode: '9', bankDisplayName: 'GSCB' }),
    ])
    expect(s.banks).toBe(3)
  })

  it('counts distinct merchants, not rows, because one merchant can hold several', () => {
    const s = summarisePool([
      entry({ asgnId: 'a', merchantDisplayName: 'KAK MEDICAL' }),
      entry({ asgnId: 'b', merchantDisplayName: 'KAK MEDICAL' }),
      entry({ asgnId: 'c', merchantDisplayName: 'KRISHNA GENERAL' }),
    ])
    expect(s.records).toBe(3)
    expect(s.merchants).toBe(2)
  })

  it('sums the kit across rows, counting soundboxes as rows that carry one', () => {
    const s = summarisePool([
      entry({ asgnId: 'a', soundbox: true, standeeCount: 2, stickerCount: 6 }),
      entry({ asgnId: 'b', soundbox: false, standeeCount: 1, stickerCount: 0 }),
    ])
    expect(s.soundboxes).toBe(1)
    expect(s.standees).toBe(3)
    expect(s.stickers).toBe(6)
  })
})

describe('BatchPreviewCard', () => {
  it('says the minimum lot is met once the pool reaches it', () => {
    render(<BatchPreviewCard rows={[entry({ asgnId: 'a' }), entry({ asgnId: 'b' })]} minLotSize={2} />)
    expect(screen.getByText(/meets minimum lot size \(2\)/i)).toBeTruthy()
  })

  it('states the shortfall rather than a bare cross while the pool is short', () => {
    render(<BatchPreviewCard rows={[entry({ asgnId: 'a' })]} minLotSize={50} />)
    expect(screen.getByText(/1 of 50 toward the minimum lot/i)).toBeTruthy()
    expect(screen.queryByText(/meets minimum lot size/i)).toBeNull()
  })

  it('says nothing about the lot size when none is configured', () => {
    // A tick or a cross against a threshold nobody set would be a claim the
    // screen cannot make.
    render(<BatchPreviewCard rows={[entry()]} minLotSize={null} />)
    expect(screen.queryByText(/minimum lot/i)).toBeNull()
  })

  it('renders no invented page estimate: imposition is unknown until a vendor is bound', () => {
    render(<BatchPreviewCard rows={[entry()]} minLotSize={50} />)
    expect(screen.queryByText(/pages/i)).toBeNull()
  })

  it('holds up on an empty pool instead of rendering blanks', () => {
    const { container } = render(<BatchPreviewCard rows={[]} minLotSize={50} />)
    const records = within(container).getByText('Records').parentElement!
    expect(within(records).getByText('0')).toBeTruthy()
  })
})
