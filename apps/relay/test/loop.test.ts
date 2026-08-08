import { describe, it, expect, vi } from 'vitest'
import { resolveTickSeconds, runLoop, runRelay, DEFAULT_TICK_SECONDS } from '../src/loop.js'
import { assertRelayContextsAreSafe, RELAY_CONTEXTS } from '../src/contexts.js'

describe('resolveTickSeconds', () => {
  it('defaults when unset', () => {
    expect(resolveTickSeconds(undefined)).toBe(DEFAULT_TICK_SECONDS)
  })

  it('takes a valid value', () => {
    expect(resolveTickSeconds('5')).toBe(5)
  })

  // THE BUSY-LOOP HAZARD. setTimeout(fn, NaN) clamps to 1ms in Node, so a typo
  // would drive a claim transaction against four databases every millisecond.
  it.each(['abc', '0', '-1', ''])('falls back and WARNS on %o rather than busy-looping', (raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(resolveTickSeconds(raw)).toBe(DEFAULT_TICK_SECONDS)
      expect(warn, 'a provided-but-rejected value must warn, or the operator never sees their typo').toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('does NOT warn when the value was simply absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      resolveTickSeconds(undefined)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('runLoop', () => {
  it('stops promptly when shouldStop flips DURING a tick, with no extra sleep', async () => {
    let stop = false
    const sleep = vi.fn(async () => {})
    let ticks = 0
    await runLoop({
      tick: async () => {
        ticks++
        stop = true
      },
      sleep,
      shouldStop: () => stop,
      tickMs: 1000,
    })
    expect(ticks).toBe(1)
    expect(sleep, 'a stop requested during a tick must not be followed by a sleep').not.toHaveBeenCalled()
  })

  it('alternates tick and sleep until stopped', async () => {
    const order: string[] = []
    let n = 0
    await runLoop({
      tick: async () => {
        order.push('tick')
        n++
      },
      sleep: async () => {
        order.push('sleep')
      },
      shouldStop: () => n >= 3,
      tickMs: 1,
    })
    expect(order).toEqual(['tick', 'sleep', 'tick', 'sleep', 'tick'])
  })
})

describe('runRelay one-shot', () => {
  it('ticks exactly once and never sleeps when once=true', async () => {
    const sleep = vi.fn(async () => {})
    let ticks = 0
    await runRelay({
      once: true,
      tick: async () => {
        ticks++
      },
      sleep,
      shouldStop: () => false, // would loop forever if `once` were ignored
      tickMs: 1,
    })
    expect(ticks).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('relay context table', () => {
  it('accepts the shipped table', () => {
    expect(() => { assertRelayContextsAreSafe() }).not.toThrow()
  })

  // SET LOCAL ROLE cannot be parameterised, so the role name is interpolated.
  // The shipped names are compile-time constants, but the guard must actually
  // bite or it is decoration.
  it('rejects a role name that could smuggle SQL through the SET LOCAL ROLE seam', () => {
    expect(() =>
      { assertRelayContextsAreSafe([{ name: 'evil', role: 'x; DROP TABLE outbox', urlEnv: 'X' }]) },
    ).toThrow(/unsafe role name/)
  })

  it('every context drains under its OWN role, never a shared one', () => {
    const roles = RELAY_CONTEXTS.map((c) => c.role)
    expect(new Set(roles).size).toBe(roles.length)
    for (const c of RELAY_CONTEXTS) expect(c.role).toBe(`${c.name}_relay`)
  })
})
