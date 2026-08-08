import { describe, it, expect } from 'vitest'
import {
  baseTopic,
  isDlqTopic,
  ladderLevel,
  nextLadderTopic,
  ladderDelayMs,
  retryAndDlqTopics,
  isEnvelopeTopic,
  DEFAULT_RETRY_LEVELS,
} from '../src/index.js'

const BASE = 'fct.tms.bank_file_row.v1'

describe('ladder navigation', () => {
  it('walks base to retry.1 to retry.2 to retry.3 to dlq', () => {
    const walk: string[] = [BASE]
    let t = BASE
    for (let i = 0; i < 4; i++) {
      t = nextLadderTopic(t)
      walk.push(t)
    }
    expect(walk).toEqual([
      BASE,
      `${BASE}.retry.1`,
      `${BASE}.retry.2`,
      `${BASE}.retry.3`,
      `${BASE}.dlq`,
    ])
  })

  it('makes the DLQ a FIXED POINT, so a message failing from the DLQ cannot bounce', () => {
    // Returning the same topic lets a caller detect terminality with
    // `next === current` rather than by catching an exception.
    expect(nextLadderTopic(`${BASE}.dlq`)).toBe(`${BASE}.dlq`)
  })

  it('reports the DLQ level as Infinity, so it never reads as "one attempt left"', () => {
    expect(ladderLevel(`${BASE}.dlq`)).toBe(Infinity)
    expect(ladderLevel(BASE)).toBe(0)
    expect(ladderLevel(`${BASE}.retry.2`)).toBe(2)
  })

  it('strips any ladder suffix back to the base', () => {
    expect(baseTopic(BASE)).toBe(BASE)
    expect(baseTopic(`${BASE}.retry.3`)).toBe(BASE)
    expect(baseTopic(`${BASE}.dlq`)).toBe(BASE)
  })

  it('does not mistake a topic that merely CONTAINS retry or dlq for a ladder rung', () => {
    expect(ladderLevel('fct.x.retry.1.v1')).toBe(0)
    expect(isDlqTopic('fct.x.dlq.v1')).toBe(false)
    expect(baseTopic('fct.x.dlq.v1')).toBe('fct.x.dlq.v1')
  })

  it('honours a non-default rung count', () => {
    expect(nextLadderTopic(`${BASE}.retry.1`, 1)).toBe(`${BASE}.dlq`)
  })
})

describe('ladder backoff', () => {
  it('does not delay a first delivery', () => {
    expect(ladderDelayMs(BASE)).toBe(0)
  })

  it('waits progressively longer on each rung', () => {
    const delays = [1, 2, 3].map((n) => ladderDelayMs(`${BASE}.retry.${String(n)}`))
    expect(delays).toEqual([1_000, 5_000, 15_000])
    // Strictly increasing, or a later rung would retry a slow dependency no
    // more patiently than an earlier one.
    expect([...delays].sort((a, b) => a - b)).toEqual(delays)
  })

  it('does not delay the DLQ, which is a destination and not an attempt', () => {
    expect(ladderDelayMs(`${BASE}.dlq`)).toBe(0)
  })
})

describe('the ladder agrees with the topics that are actually provisioned', () => {
  // THE INVARIANT THAT MATTERS. retryAndDlqTopics MINTS the names at
  // provisioning time and the ladder NAVIGATES them at runtime. If they ever
  // disagree, a consumer publishes a retry to a topic that was never created,
  // and the message vanishes rather than being retried.
  it('every topic the ladder can route to was provisioned by retryAndDlqTopics', () => {
    const provisioned = new Set(retryAndDlqTopics(BASE, DEFAULT_RETRY_LEVELS).map((t) => t.name))
    let t = BASE
    for (let i = 0; i < DEFAULT_RETRY_LEVELS + 1; i++) {
      t = nextLadderTopic(t)
      expect(provisioned.has(t), `${t} is routable but never provisioned`).toBe(true)
    }
  })

  it('a rung inherits its base topic CODEC, so a retry is not judged by a different rule', () => {
    expect(isEnvelopeTopic('authz.audit')).toBe(false)
    expect(isEnvelopeTopic(nextLadderTopic('authz.audit'))).toBe(false)
    expect(isEnvelopeTopic(BASE)).toBe(true)
    expect(isEnvelopeTopic(nextLadderTopic(BASE))).toBe(true)
  })
})
