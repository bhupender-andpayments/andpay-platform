/**
 * The relay poll loop.
 *
 * The SHAPE is copied from apps/scheduler/src/loop.ts deliberately, and the
 * scheduler is deliberately NOT imported: that is a DOMAIN timer firing due
 * max_wait batch timers against fulfillment only, this is INFRASTRUCTURE
 * draining four context outboxes under four infra roles. Same loop, different
 * blast radius, different DB roles, separate deployable (ruling A-6.1).
 */

/**
 * Two seconds, not the scheduler's sixty. The relay is the latency floor for
 * EVERYTHING downstream of an upload, and its work is IO-light (claim,
 * publish, stamp), so a short poll is cheap. Ruling A-6.4 chose a fixed
 * interval over LISTEN/NOTIFY: notifications are missed across reconnects, so
 * a fallback poll would be needed anyway, which makes LISTEN/NOTIFY a later
 * optimisation on top of this rather than an alternative to it.
 */
export const DEFAULT_TICK_SECONDS = 2

/**
 * Resolves RELAY_TICK_SECONDS into a sane, positive cadence. PURE: takes the
 * raw env string (or undefined) and returns a number.
 *
 * Guards the same busy-loop hazard the scheduler documents: `Number(raw)` on a
 * non-numeric value is NaN, and `setTimeout(fn, NaN)` silently clamps to 1ms in
 * Node, so a typo like RELAY_TICK_SECONDS=abc would drive a full claim
 * transaction roughly every millisecond against four databases with no warning.
 * Missing, NaN, zero and negative all fall back to the default; only a value
 * that was PROVIDED but rejected also warns, so an operator sees their typo
 * instead of silently getting the default.
 */
export function resolveTickSeconds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TICK_SECONDS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `RELAY_TICK_SECONDS="${raw}" is not a positive number; using the default ${String(DEFAULT_TICK_SECONDS)}s instead`,
    )
    return DEFAULT_TICK_SECONDS
  }
  return n
}

export interface RunLoopOptions {
  tick: () => Promise<void>
  /** Injected so tests need no real timer, and so the real one can wake early on shutdown. */
  sleep: (ms: number) => Promise<void>
  /** Polled before the first tick and again right after each tick, so a stop requested DURING a tick is honoured without an extra sleep. */
  shouldStop: () => boolean
  tickMs: number
}

/**
 * SEQUENTIAL await-then-sleep, so a tick never overlaps itself locally. Real
 * cross-process overlap is independently safe: the claim is FOR UPDATE SKIP
 * LOCKED.
 */
export async function runLoop(opts: RunLoopOptions): Promise<void> {
  while (!opts.shouldStop()) {
    await opts.tick()
    if (opts.shouldStop()) break
    await opts.sleep(opts.tickMs)
  }
}

export interface RunRelayOptions extends RunLoopOptions {
  /** RELAY_ONCE=1: drain once and return. Maps to a one-shot invocation with zero code difference from the loop. */
  once: boolean
}

export async function runRelay(opts: RunRelayOptions): Promise<void> {
  if (opts.once) {
    await opts.tick()
    return
  }
  await runLoop(opts)
}
