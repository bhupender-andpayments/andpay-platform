import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveTickSeconds, DEFAULT_TICK_SECONDS, runLoop, runScheduler } from '../src/loop.js'

// A sleep double that never resolves on its own (no real timer at all): it
// only resolves when the test calls `release()`. This is the deterministic
// stand-in for main.ts's real sleep, which is itself interruptible (wakes
// early on SIGTERM/SIGINT rather than waiting out the remaining interval).
// `called` resolves exactly when `sleep()` is first invoked, which the tests
// use instead of guessing microtask counts to know when the loop has reached
// its post-tick sleep call.
function createGatedSleep(): {
  sleep: (ms: number) => Promise<void>
  release: () => void
  called: Promise<void>
} {
  let resolveSleep: (() => void) | null = null
  let notifyCalled: (() => void) | null = null
  const called = new Promise<void>((resolve) => {
    notifyCalled = resolve
  })
  const sleep = (_ms: number): Promise<void> => {
    notifyCalled?.()
    return new Promise<void>((resolve) => {
      resolveSleep = resolve
    })
  }
  const release = (): void => {
    resolveSleep?.()
  }
  return { sleep, release, called }
}

describe('resolveTickSeconds (fix round, Finding 1: guard the SCHEDULER_TICK_SECONDS 0/NaN/negative busy-loop hazard)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('missing (undefined): returns the default, no warning', () => {
    expect(resolveTickSeconds(undefined)).toBe(DEFAULT_TICK_SECONDS)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('non-numeric ("abc"): NaN falls back to the default, WITH a warning (a value was provided but rejected)', () => {
    expect(resolveTickSeconds('abc')).toBe(DEFAULT_TICK_SECONDS)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('"0": would clamp setTimeout to a busy loop, so it falls back to the default, WITH a warning', () => {
    expect(resolveTickSeconds('0')).toBe(DEFAULT_TICK_SECONDS)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('"-5": negative falls back to the default, WITH a warning', () => {
    expect(resolveTickSeconds('-5')).toBe(DEFAULT_TICK_SECONDS)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('"30": a valid positive value is used as-is, no warning', () => {
    expect(resolveTickSeconds('30')).toBe(30)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('runLoop (fix round, Finding 2: the local-dev loop core, unit-tested with a fake tick/sleep, no DB, no real timers)', () => {
  it('ticks once, then stops promptly once the stop flag flips while sleeping (does not wait out the full interval)', async () => {
    let ticks = 0
    let stopped = false
    const { sleep, release, called } = createGatedSleep()

    const donePromise = runLoop({
      tick: async () => {
        ticks += 1
      },
      sleep,
      shouldStop: () => stopped,
      // A huge interval: if the loop had to wait it out (rather than being
      // woken by an interruptible sleep) this test would time out instead of
      // completing, so a passing test is itself proof of promptness.
      tickMs: 10 * 60 * 1000,
    })

    // Resolves exactly when the loop has ticked once and called sleep(),
    // i.e. it is now blocked awaiting the (gated) sleep promise.
    await called
    expect(ticks).toBe(1)

    stopped = true
    release() // simulate requestStop() waking an in-progress sleep immediately

    await donePromise
    expect(ticks).toBe(1) // exits after the flip; never runs a second tick
  })

  it('shouldStop already true before the first tick: never ticks at all', async () => {
    let ticks = 0
    await runLoop({
      tick: async () => {
        ticks += 1
      },
      sleep: () => Promise.resolve(),
      shouldStop: () => true,
      tickMs: 1000,
    })
    expect(ticks).toBe(0)
  })

  it('runs multiple cycles when sleep resolves and the stop flag is not yet set, then stops on the flag', async () => {
    let ticks = 0
    const stopAfter = 3
    await runLoop({
      tick: async () => {
        ticks += 1
      },
      sleep: () => Promise.resolve(), // resolves immediately: no real timer
      shouldStop: () => ticks >= stopAfter,
      tickMs: 1,
    })
    expect(ticks).toBe(stopAfter)
  })
})

describe('runScheduler (fix round, Finding 2: the one-shot vs loop decision, unit-tested with no DB)', () => {
  it('once=true: runs exactly one tick and returns, never calling sleep', async () => {
    let ticks = 0
    let sleepCalls = 0
    await runScheduler({
      once: true,
      tick: async () => {
        ticks += 1
      },
      sleep: async () => {
        sleepCalls += 1
      },
      shouldStop: () => false,
      tickMs: 1000,
    })
    expect(ticks).toBe(1)
    expect(sleepCalls).toBe(0)
  })

  it('once=false: delegates to the loop (ticks until shouldStop, using sleep in between)', async () => {
    let ticks = 0
    await runScheduler({
      once: false,
      tick: async () => {
        ticks += 1
      },
      sleep: () => Promise.resolve(),
      shouldStop: () => ticks >= 2,
      tickMs: 1,
    })
    expect(ticks).toBe(2)
  })
})
