// The 6d source-token-bucket seam (spec 12 task 12). Defined here, in the
// scaffold task, so `AuthEdgeDeps` has its final shape before Tasks 9 to 11
// build the login/refresh/logout/enroll controllers against it: none of them
// need to reshape `AuthEdgeDeps` once the real bucket lands.
//
// `take` returns true when the caller may proceed and false when the source
// key (a per-IP or per-handle key, decided by Task 12) is over budget. It
// never throws; a throttled caller is a normal false, not an exception, so a
// controller decides the 429 mapping itself.
export interface ThrottlePort {
  take(sourceKey: string): Promise<boolean>
}

// The permissive default (Task 8 only): every take() succeeds, so nothing is
// throttled. Retained as the test-helper default and as a documented
// no-throttle escape hatch; the real env builder now wires
// InMemoryTokenBucket, so the deployed edge is throttled by default.
export const NoThrottle: ThrottlePort = {
  async take(_sourceKey: string): Promise<boolean> {
    return true
  },
}

// The 6d brute-force control (spec 12 task 12): a per-source token bucket. The
// key is ALWAYS the request SOURCE (the origin IP, via sourceKey(req)), NEVER
// the credential/principal, so a third party can never lock out a victim by
// failing that victim's logins. There is NO per-principal hard lockout by
// design.
//
// Each source key gets a bucket of `capacity` tokens that refills at
// `refillPerSec` tokens per second (capped at capacity). `take` refills based
// on wall-clock elapsed time, then spends one token if any remain (returning
// true) or returns false when the bucket is empty. `refillPerSec: 0` disables
// time-based refill entirely: the bucket drains deterministically and never
// recovers, which is what the tests use to force a hard 429 boundary.
//
// This is app runtime code (not a workflow script), so Date.now() is the
// clock: a monotonic-enough source for a coarse-grained abuse control.
export class InMemoryTokenBucket implements ThrottlePort {
  private readonly capacity: number
  private readonly refillPerSec: number
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>()

  constructor(opts: { capacity: number; refillPerSec: number }) {
    this.capacity = opts.capacity
    this.refillPerSec = opts.refillPerSec
  }

  async take(sourceKey: string): Promise<boolean> {
    const now = Date.now()
    let bucket = this.buckets.get(sourceKey)
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillMs: now }
      this.buckets.set(sourceKey, bucket)
    } else if (this.refillPerSec > 0) {
      const elapsedSec = (now - bucket.lastRefillMs) / 1000
      if (elapsedSec > 0) {
        bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec)
        bucket.lastRefillMs = now
      }
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return true
    }
    return false
  }
}
