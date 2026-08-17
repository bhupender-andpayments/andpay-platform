import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PerRowErrors } from '../../src/components/PerRowErrors'

// The soundbox duplicate-VPA hold (ruling 2026-08-10), the counterpart to the
// malformed-QR and repeat-VPA notices in qr-malformed-notice.test.tsx.
//
// This one IS an outcome, unlike the two beside it: the rows did not ingest.
// So it renders in the amber "needs you" treatment with the row numbers and a
// link into the queue, rather than the calm sky-blue "nothing to do here"
// treatment the flag-only notice keeps.
//
// The harness is the same as the sibling suite: a MemoryRouter because the
// notice links to /queues, and an explicit cleanup because this project sets no
// `globals`, so RTL never registers its automatic per-test cleanup.
function renderResult(result: Parameters<typeof PerRowErrors>[0]['result']) {
  return render(
    <MemoryRouter>
      <PerRowErrors result={result} />
    </MemoryRouter>,
  )
}

describe('PerRowErrors: the soundbox duplicate-VPA hold notice (ruling 2026-08-10)', () => {
  afterEach(() => {
    cleanup()
  })

  it('names each held row and the original it collides with', () => {
    renderResult({
      accepted: 1,
      quarantined: 2,
      duplicate: 0,
      duplicateVpa: 2,
      duplicateVpaHeld: [
        { rowNo: 2, duplicateOf: { reference: 'asgn_01HZX', merchantDisplayName: 'Chai Point' } },
        { rowNo: 7, duplicateOf: { reference: 'file-a|3', merchantDisplayName: null } },
      ],
    })
    expect(screen.getByText(/held for review/i)).toBeTruthy()
    expect(screen.getByText('row 2 -> asgn_01HZX (Chai Point)')).toBeTruthy()
    // No name to show is a dangling empty parenthesis waiting to happen; the
    // row must read cleanly without one.
    expect(screen.getByText('row 7 -> file-a|3')).toBeTruthy()
    // Held rows are NOT accepted, so the flag-only copy must not speak for them.
    expect(screen.queryByText(/accepted, not held/i)).toBeNull()
  })

  it('renders nothing when no row was held', () => {
    const { container } = renderResult({ accepted: 3, quarantined: 0, duplicate: 0, duplicateVpaHeld: [] })
    expect(container.textContent).not.toMatch(/held for review/i)
  })

  // Every other upload surface (device inventory) shares this component and
  // never reports this list, so an absent field must not render.
  it('renders nothing when the upload has no such list', () => {
    const { container } = renderResult({ accepted: 3, quarantined: 1, duplicate: 0 })
    expect(container.textContent).not.toMatch(/held for review/i)
  })

  // The flag-only notice now speaks for the REMAINDER only. A file with three
  // repeats of which one was held has two rows that really were accepted, and
  // saying "3 of them were accepted, not held" would be false about the third.
  it('subtracts the held rows from the accepted-not-held count', () => {
    renderResult({
      accepted: 2,
      quarantined: 1,
      duplicate: 0,
      duplicateVpa: 3,
      duplicateVpaHeld: [{ rowNo: 4, duplicateOf: { reference: 'asgn_ZZZ', merchantDisplayName: 'Tea Stall' } }],
    })
    expect(screen.getByText('2 of them')).toBeTruthy()
    expect(screen.getByText(/accepted, not held/i)).toBeTruthy()
    expect(screen.getByText(/held for review/i)).toBeTruthy()
  })

  // When every repeat was held there is no remainder, so the reassuring notice
  // must disappear entirely rather than render a "0 of them".
  it('drops the accepted-not-held notice when every repeat was held', () => {
    const { container } = renderResult({
      accepted: 1,
      quarantined: 1,
      duplicate: 0,
      duplicateVpa: 1,
      duplicateVpaHeld: [{ rowNo: 2, duplicateOf: { reference: 'asgn_YYY', merchantDisplayName: null } }],
    })
    expect(container.textContent).not.toMatch(/accepted, not held/i)
    expect(screen.getByText(/held for review/i)).toBeTruthy()
  })
})
