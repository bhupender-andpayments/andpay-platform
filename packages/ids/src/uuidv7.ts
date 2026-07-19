import { randomBytes } from 'node:crypto'

/**
 * UUIDv7 generation (RFC 9562): 48 bit unix millisecond timestamp, 4 bit
 * version (7), 12 bit rand_a, 2 bit variant (0b10), 62 bit rand_b. Total 128
 * bits. rand_a plus rand_b is the 74 bits of randomness (spec 4).
 *
 * Generation is monotonic (RFC 9562 section 6.2 counter method): within one
 * millisecond the 74 random bits are treated as a counter and incremented, so
 * two ids minted in the same millisecond still sort in mint order. rand_a is
 * more significant than rand_b in the layout, and the constant variant bits sit
 * between them, so incrementing the combined 74 bit counter increments the whole
 * 128 bit value monotonically. Across a millisecond boundary the higher
 * timestamp dominates. The result: every id sorts after the previous one.
 *
 * IN PROCESS ONLY (I2): no network, no central service, no DB sequence.
 */

const MASK_74 = (1n << 74n) - 1n
const MASK_62 = (1n << 62n) - 1n
const MASK_12 = (1n << 12n) - 1n

let lastMs = -1n
let lastRand = 0n

function random74(): bigint {
  const buf = randomBytes(10)
  let v = 0n
  for (const byte of buf) {
    v = (v << 8n) | BigInt(byte)
  }
  return v & MASK_74
}

/** Produce the next UUIDv7 as a 128 bit integer, monotonic within a process. */
export function nextUuidV7(): bigint {
  const now = BigInt(Date.now())
  if (now > lastMs) {
    lastMs = now
    lastRand = random74()
  } else {
    // Same millisecond, or the wall clock went backwards. Never emit a
    // non-increasing value: keep the last timestamp and step the counter.
    lastRand += 1n
    if (lastRand > MASK_74) {
      // 74 bit counter exhausted in a single millisecond (not reachable in
      // practice). Borrow a millisecond and reseed.
      lastMs += 1n
      lastRand = random74()
    }
  }

  const randA = (lastRand >> 62n) & MASK_12
  const randB = lastRand & MASK_62

  return (
    (lastMs << 80n) |
    (0x7n << 76n) |
    (randA << 64n) |
    (0b10n << 62n) |
    randB
  )
}

/** Recover the unix millisecond timestamp from a UUIDv7 128 bit integer. */
export function timestampMsOf(value: bigint): number {
  return Number(value >> 80n)
}
