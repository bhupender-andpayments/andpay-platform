import { useEffect, useRef } from 'react'

// Keeps a page honest about data that lands AFTER it mounted.
//
// The motivating case is the bank upload: ops-edge commits TMS rows and their
// outbox facts in one transaction, the relay publishes on a 2s tick, and the
// fulfillment consumer only then inserts pending_pool_entry. So an operator
// who commits a file and walks straight to /batches arrives BEFORE the data
// does, the mount fetch truthfully reports an empty pool, and a page that only
// reads once stays wrong until a manual browser reload. Fetch-on-mount was
// never the missing piece; noticing what lands afterwards is.
//
// Three behaviours, one place, so pages cannot drift apart on any of them:
//
// - A SETTLE BURST right after mount (~2s and ~4s). The relay tick is 2s, so
//   the burst catches a just-committed file on its first or second try. The
//   steady interval alone would leave up to a full period of "Nothing here
//   yet" at exactly the moment the operator is watching hardest.
// - A steady interval after that, skipped entirely while document.hidden: a
//   Batches tab left open behind other work must not read its endpoints all
//   afternoon.
// - An immediate re-read when the tab becomes visible again, because that is
//   precisely when the answer on screen is most likely stale.
//
// The refetch should be QUIET (no loading skeletons, errors swallowed): a
// background tick that flashes skeletons over a table someone is reading, or
// replaces a working page with an error banner because tick 12 hit a blip, is
// worse than no poll. Both callers pass the quiet variant of their `load`.
const SETTLE_DELAYS_MS = [2_000, 4_000] as const

export function usePagePoll(refetch: () => void, intervalMs = 8_000): void {
  // A ref rather than an effect dependency, so a caller passing an inline
  // arrow (they all do) does not tear the timers down and restart the settle
  // burst on every render.
  const fn = useRef(refetch)
  fn.current = refetch

  useEffect(() => {
    const tick = (): void => {
      if (!document.hidden) fn.current()
    }
    const settleTimers = SETTLE_DELAYS_MS.map((ms) => setTimeout(tick, ms))
    const interval = setInterval(tick, intervalMs)
    document.addEventListener('visibilitychange', tick)
    return () => {
      for (const t of settleTimers) clearTimeout(t)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [intervalMs])
}
