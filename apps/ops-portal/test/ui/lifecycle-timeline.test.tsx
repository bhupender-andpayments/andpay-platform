import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { LifecycleTimeline } from '../../src/ui/LifecycleTimeline.js'

// The shared timeline's ONE non-negotiable rule: it shows a time only when it was
// given one. Our stores keep real per-transition history for the courier legs and
// for activation, and none at all for anything earlier, so a rung that renders a
// borrowed or invented instant would be the page lying about the audit trail.

describe('LifecycleTimeline', () => {
  afterEach(() => cleanup())

  it('shows an instant for the stages that have one and NO time at all for the stages that do not', () => {
    render(
      <LifecycleTimeline
        stages={[
          { key: 'a', label: 'Received', sub: 'request accepted', state: 'reached' },
          {
            key: 'b',
            label: 'Delivered',
            state: 'current',
            at: '2026-08-12T09:00:00.000Z',
            atLabel: 'reported',
          },
        ]}
      />,
    )

    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    // The dated stage carries its label and its instant.
    expect(items[1]!.textContent).toContain('reported')
    // The undated one carries neither a time nor a placeholder standing in for one.
    expect(items[0]!.textContent).toContain('Received')
    expect(items[0]!.textContent).not.toContain('reported')
    expect(items[0]!.textContent).not.toContain('-')
  })

  it('treats an empty string instant as no instant, so a blank wire value cannot become a fake time', () => {
    render(<LifecycleTimeline stages={[{ key: 'a', label: 'Received', state: 'reached', at: '' }]} />)
    expect(screen.getByRole('listitem').textContent).toBe('Received')
  })

  it('names the channel and the actor when a trail records them', () => {
    render(
      <LifecycleTimeline
        stages={[
          {
            key: 'a',
            label: 'Activated',
            state: 'current',
            at: '2026-08-12T09:00:00.000Z',
            source: 'ops:mark-activated',
            actor: 'actor-9',
          },
        ]}
      />,
    )
    expect(screen.getByText(/via ops:mark-activated/i)).toBeTruthy()
    expect(screen.getByText(/by actor-9/i)).toBeTruthy()
  })

  it('says nothing happened rather than rendering an empty box', () => {
    render(<LifecycleTimeline stages={[]} emptyMessage="No courier updates for this AWB yet." />)
    expect(screen.getByText(/no courier updates for this awb yet/i)).toBeTruthy()
  })

  it('closes the spine with a terminal entry when a lifecycle really ended', () => {
    render(
      <LifecycleTimeline
        stages={[{ key: 'a', label: 'In transit', state: 'reached', at: '2026-08-12T09:00:00.000Z' }]}
        terminal={{ label: 'Returned to origin', sub: 'the parcel came back', at: '2026-08-13T09:00:00.000Z' }}
      />,
    )
    expect(screen.getByText('Returned to origin')).toBeTruthy()
    expect(screen.getByText(/the parcel came back/i)).toBeTruthy()
  })
})
