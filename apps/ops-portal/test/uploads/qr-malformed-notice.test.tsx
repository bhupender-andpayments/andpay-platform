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

// D-2, the repeat-VPA review flag. Same shape as the notice above and for the
// same reason: nothing failed, so it must not read as a failure. The wording
// carries the reason a repeat is usually FINE (an additional soundbox for an
// existing merchant), because an operator who reads "duplicate" as "problem"
// will start holding legitimate orders.
describe('PerRowErrors: the repeat-VPA notice (D-2)', () => {
  afterEach(() => {
    cleanup()
  })

  it('reports the count and says the rows were accepted, not held', () => {
    renderResult({ accepted: 3, quarantined: 0, duplicate: 0, duplicateVpa: 1 })
    expect(screen.getByText('1 of them')).toBeTruthy()
    expect(screen.getByText(/accepted, not held/i)).toBeTruthy()
  })

  it('renders nothing when no VPA repeated', () => {
    const { container } = renderResult({ accepted: 3, quarantined: 0, duplicate: 0, duplicateVpa: 0 })
    expect(container.textContent).not.toMatch(/repeat/i)
  })

  // Both notices can be true of one file, and neither should swallow the other.
  it('renders alongside the malformed-QR notice', () => {
    renderResult({ accepted: 3, quarantined: 0, duplicate: 0, qrMalformed: 2, duplicateVpa: 1 })
    expect(screen.getByText(/malformed QR separator/i)).toBeTruthy()
    expect(screen.getByText(/accepted, not held/i)).toBeTruthy()
  })
})
