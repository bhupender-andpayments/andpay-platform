import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PerRowErrors } from '../../src/components/PerRowErrors'

// D-8. The D4 ruling corrected the bank's malformed QR separator at the artifact
// boundary and ended: "This is a compensating control for a bank-side bug, not a
// fix. GSCB should still be told." Until now nothing surfaced the number, so the
// correction was silent and nobody could tell GSCB anything, nor notice if the
// bank fixed their export or regressed.
//
// It is deliberately NOT rendered as another failure count beside Accepted and
// Quarantined. Nothing failed: those rows ingested fine and the payload is
// corrected downstream automatically. Presenting it as an error would train an
// operator to treat a clean upload as broken.
function renderResult(result: Parameters<typeof PerRowErrors>[0]['result']) {
  return render(
    <MemoryRouter>
      <PerRowErrors result={result} />
    </MemoryRouter>,
  )
}

describe('PerRowErrors: the malformed-QR notice (D-8)', () => {
  // This project sets no `globals`, so RTL never registers its automatic
  // per-test cleanup and renders would otherwise accumulate within the file.
  // Same explicit cleanup the auth suites use.
  afterEach(() => {
    cleanup()
  })

  it('reports the count, and says it was corrected rather than rejected', () => {
    renderResult({ accepted: 360, quarantined: 0, duplicate: 0, qrMalformed: 360 })
    expect(screen.getByText('360 of them')).toBeTruthy()
    // The operator must be told this needs no action from them.
    expect(screen.getByText(/corrected automatically/i)).toBeTruthy()
  })

  // The whole point is that zero is the interesting case: if GSCB ever fix their
  // export, the notice must DISAPPEAR rather than render a reassuring "0", which
  // nobody would notice changing.
  it('renders nothing at all when the bank file was clean', () => {
    const { container } = renderResult({ accepted: 10, quarantined: 0, duplicate: 0, qrMalformed: 0 })
    expect(container.textContent).not.toMatch(/QR/i)
  })

  // Every other upload surface (damage, device inventory) shares this component
  // and never reports this count, so an absent field must not render.
  it('renders nothing when the upload has no such count', () => {
    const { container } = renderResult({ replaced: 3, quarantined: 1, duplicate: 0 })
    expect(container.textContent).not.toMatch(/QR/i)
  })

  it('still renders the ordinary counts alongside the notice', () => {
    renderResult({ accepted: 358, quarantined: 2, duplicate: 0, qrMalformed: 360 })
    expect(screen.getByText('Accepted')).toBeTruthy()
    expect(screen.getByText('358')).toBeTruthy()
  })
})

// D-2, the repeat-VPA notice. This notice ASSERTED THE OPPOSITE of the server's
// behaviour for a while, and these tests held it in place: the 2026-08-11 ruling
// made a repeat VPA QUARANTINE rather than commit, tms/ops.ts started passing
// 'duplicate_vpa' to the quarantine writer, and this paragraph went on saying
// "accepted, not held" with a green test guarding it.
//
// The failure that surfaced it: re-upload a committed bank file, every row
// repeats, so accepted is 0. The operator got a red "Nothing was committed"
// toast and, right underneath, this notice telling them the rows were accepted.
//
// So the assertions now pin the ruling itself. The wording still carries WHY a
// repeat is often legitimate (an additional soundbox for an existing merchant),
// because that is what makes Queues a decision and not a dead end, but it must
// never again claim the rows went through.
describe('PerRowErrors: the repeat-VPA notice (D-2)', () => {
  afterEach(() => {
    cleanup()
  })

  it('reports the count and says the rows were HELD, not committed', () => {
    renderResult({ accepted: 3, quarantined: 1, duplicate: 0, duplicateVpa: 1 })
    expect(screen.getByText('1 row(s)')).toBeTruthy()
    expect(screen.getByText(/held in quarantine, not committed/i)).toBeTruthy()
  })

  // The regression itself, stated as a test: no phrasing of this notice may tell
  // an operator a repeat was accepted.
  it('never says the repeats were accepted', () => {
    const { container } = renderResult({ accepted: 0, quarantined: 3, duplicate: 0, duplicateVpa: 3 })
    expect(container.textContent).not.toMatch(/accepted, not held/i)
  })

  it('routes the operator to Queues, where the row can actually be accepted', () => {
    renderResult({ accepted: 0, quarantined: 1, duplicate: 0, duplicateVpa: 1 })
    expect(screen.getByRole('link', { name: /open queues/i })).toBeTruthy()
  })

  it('renders nothing when no VPA repeated', () => {
    const { container } = renderResult({ accepted: 3, quarantined: 0, duplicate: 0, duplicateVpa: 0 })
    expect(container.textContent).not.toMatch(/repeat/i)
  })

  // Both notices can be true of one file, and neither should swallow the other.
  it('renders alongside the malformed-QR notice', () => {
    renderResult({ accepted: 3, quarantined: 1, duplicate: 0, qrMalformed: 2, duplicateVpa: 1 })
    expect(screen.getByText(/malformed QR separator/i)).toBeTruthy()
    expect(screen.getByText(/held in quarantine, not committed/i)).toBeTruthy()
  })
})

// The mobile flag is a SEPARATE notice with separate wording, because it means
// something different: not one merchant returning, but two merchants sharing a
// contact number. Measured in the real GSCB file, this is the flag that
// actually fires (3 shared mobiles, 0 repeated VPAs).
describe('PerRowErrors: the shared-mobile notice (D-2)', () => {
  afterEach(() => {
    cleanup()
  })

  it('names the different merchant rather than calling it a duplicate', () => {
    renderResult({ accepted: 3, quarantined: 0, duplicate: 0, duplicateMobile: 2 })
    expect(screen.getByText('2 of them')).toBeTruthy()
    expect(screen.getByText(/different merchant/i)).toBeTruthy()
  })

  it('renders nothing when no mobile is shared', () => {
    const { container } = renderResult({ accepted: 3, quarantined: 0, duplicate: 0, duplicateMobile: 0 })
    expect(container.textContent).not.toMatch(/mobile/i)
  })

  // The two duplicate flags are independent and must both be visible: a file can
  // contain a returning merchant AND a shared number, and they need different
  // actions from whoever reads them.
  it('renders independently of the repeat-VPA notice', () => {
    renderResult({ accepted: 4, quarantined: 0, duplicate: 0, duplicateVpa: 1, duplicateMobile: 2 })
    expect(screen.getByText(/additional soundbox/i)).toBeTruthy()
    expect(screen.getByText(/different merchant/i)).toBeTruthy()
  })
})
