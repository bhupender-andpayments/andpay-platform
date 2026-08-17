import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { usePagePoll } from '../../src/lib/usePagePoll.js'

// The page-freshness hook. It exists because data can land AFTER a page
// mounts: the bank upload's pool rows travel outbox -> relay (2s tick) ->
// Kafka -> consumer, so an operator who commits and walks straight to
// /batches arrives before the data does. The hook's contract is exactly what
// these tests pin: a fast settle burst for that arrival window, a steady
// interval after it, silence while hidden, and an immediate catch-up on
// becoming visible.

function Harness({ refetch }: { refetch: () => void }) {
  usePagePoll(refetch)
  return null
}

let hidden = false

beforeEach(() => {
  vi.useFakeTimers()
  hidden = false
  // jsdom has no real tab visibility; the hook reads document.hidden, so the
  // tests own it.
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('usePagePoll', () => {
  it('fires the settle burst at ~2s and ~4s, NOT only at the steady interval', () => {
    const refetch = vi.fn()
    render(<Harness refetch={refetch} />)
    expect(refetch).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2_100)
    expect(refetch).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2_000)
    expect(refetch).toHaveBeenCalledTimes(2)
  })

  it('keeps ticking at the steady interval after the burst', () => {
    const refetch = vi.fn()
    render(<Harness refetch={refetch} />)
    vi.advanceTimersByTime(8_100)
    // 2s + 4s burst + the 8s interval tick.
    expect(refetch).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(8_000)
    expect(refetch).toHaveBeenCalledTimes(4)
  })

  it('stays silent while the tab is hidden', () => {
    const refetch = vi.fn()
    hidden = true
    render(<Harness refetch={refetch} />)
    vi.advanceTimersByTime(30_000)
    expect(refetch).not.toHaveBeenCalled()
  })

  it('re-reads immediately when the tab becomes visible again', () => {
    const refetch = vi.fn()
    hidden = true
    render(<Harness refetch={refetch} />)
    vi.advanceTimersByTime(30_000)

    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('tears everything down on unmount', () => {
    const refetch = vi.fn()
    const { unmount } = render(<Harness refetch={refetch} />)
    unmount()
    vi.advanceTimersByTime(60_000)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(refetch).not.toHaveBeenCalled()
  })

  it('always calls the LATEST callback, so a caller passing an inline arrow does not poll stale state', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Harness refetch={first} />)
    rerender(<Harness refetch={second} />)
    vi.advanceTimersByTime(2_100)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
