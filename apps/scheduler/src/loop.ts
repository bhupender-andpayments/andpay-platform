// The default poll cadence (seconds), used both as the fallback when
// SCHEDULER_TICK_SECONDS is absent and as the floor an invalid value falls
// back to (fix round, Finding 1).
export const DEFAULT_TICK_SECONDS = 60

/**
 * Resolves SCHEDULER_TICK_SECONDS (R4) into a sane, positive cadence. PURE:
 * takes the raw env string (or undefined) and returns a number, no env
 * reads and no side effects other than the one console.warn below.
 *
 * Guards the busy-loop hazard (fix round, Finding 1): `Number(raw)` on a
 * non-numeric value is NaN, and `setTimeout(fn, NaN)` silently clamps to 1ms
 * in Node, so an operator typo (e.g. SCHEDULER_TICK_SECONDS=abc) would have
 * driven a full DB claim transaction roughly every millisecond with no
 * warning. Missing, NaN, zero, or negative all fall back to
 * DEFAULT_TICK_SECONDS; only a value that was PROVIDED but rejected also
 * logs a warning, so the operator sees their typo instead of silently
 * getting the default with no signal.
 */
export function resolveTickSeconds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TICK_SECONDS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `SCHEDULER_TICK_SECONDS="${raw}" is not a positive number; using the default ${String(DEFAULT_TICK_SECONDS)}s instead`,
    )
    return DEFAULT_TICK_SECONDS
  }
  return n
}

export interface RunLoopOptions {
  // Runs one batching tick. The loop does not interpret its return value
  // (main.ts wires it to runBatchingTick(db, new Date())); errors propagate
  // and end the loop, same as an unhandled rejection would.
  tick: () => Promise<void>
  // Waits out one poll interval. Injected so tests can supply an
  // interruptible fake with no real timer (see test/loop.test.ts); main.ts's
  // real implementation is itself interruptible (wakes early on shutdown).
  sleep: (ms: number) => Promise<void>
  // Polled before the first tick and again right after each tick, so a stop
  // requested WHILE a tick is running is honored on the very next check
  // rather than after an extra sleep.
  shouldStop: () => boolean
  tickMs: number
}

/**
 * The local-dev loop core (R3), extracted so it is unit-testable without a
 * DB or a real process (fix round, Finding 2): SEQUENTIAL await-then-sleep,
 * so a tick never overlaps ITSELF locally (the engine's own FOR UPDATE SKIP
 * LOCKED claim independently guards real cross-process overlap). Exits
 * promptly once `shouldStop` flips, PROVIDED the injected `sleep` is itself
 * interruptible (main.ts's real sleep wakes early on SIGTERM/SIGINT; this
 * function does not and cannot force that on a non-cooperative sleep).
 */
export async function runLoop(opts: RunLoopOptions): Promise<void> {
  while (!opts.shouldStop()) {
    await opts.tick()
    if (opts.shouldStop()) break
    await opts.sleep(opts.tickMs)
  }
}

export interface RunSchedulerOptions extends RunLoopOptions {
  // SCHEDULER_ONCE=1 (R3): run a single tick and return, instead of looping.
  // The same entrypoint maps to a cron/EventBridge one-shot invocation in
  // prod with zero code difference from the local loop.
  once: boolean
}

/**
 * The top of the local-dev-loop-vs-one-shot decision (fix round, Finding 2):
 * extracted out of main.ts alongside runLoop so BOTH branches are
 * unit-testable with a fake tick/sleep and no DB. main.ts's own `main()` is
 * now just: build the real DB client, wire signal handlers, call this, and
 * disconnect in a finally.
 */
export async function runScheduler(opts: RunSchedulerOptions): Promise<void> {
  if (opts.once) {
    await opts.tick()
    return
  }
  await runLoop(opts)
}
