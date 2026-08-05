import { PrismaClient, type FulfillmentDb } from '@andpay/fulfillment-service'
import { runBatchingTick } from './tick.js'
import { resolveTickSeconds, runScheduler } from './loop.js'

// SCHEDULER_TICK_SECONDS (R4): the local poll cadence, default 60 seconds. A
// short poll is correct here because the model is timer-based, not
// schedule-based: this loop only fires already-DUE max_wait timers promptly.
// It is NOT a once-daily job. The BRD "4pm IST" window is the max_wait
// DURATION itself, resolved per-pool from batching_config (see
// services/fulfillment/src/config/pool-config.ts), not this poll cadence.
// resolveTickSeconds (fix round, Finding 1) guards a missing/NaN/<=0 value
// (e.g. a typo'd SCHEDULER_TICK_SECONDS=abc) so it can never collapse to
// setTimeout's <=0 clamp-to-1ms behavior and busy-loop DB claim
// transactions; it falls back to the default and warns when a value was
// provided but rejected.
const TICK_SECONDS = resolveTickSeconds(process.env.SCHEDULER_TICK_SECONDS)

let sleepTimer: ReturnType<typeof setTimeout> | null = null
let wakeEarly: (() => void) | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    wakeEarly = resolve
    sleepTimer = setTimeout(resolve, ms)
  })
}

let stopped = false

// Graceful shutdown (R3): a signal sets the stop flag and wakes an in-progress
// sleep immediately (rather than waiting out the remainder of the poll
// interval), so the loop notices on its next check and exits promptly. It
// never interrupts a tick already in flight; the loop only re-checks `stopped`
// between ticks, and the running tick's own DB transactions are left to
// commit or roll back normally.
function requestStop(): void {
  stopped = true
  if (sleepTimer) clearTimeout(sleepTimer)
  wakeEarly?.()
}

// The real process bootstrap (R3). Reads FULFILLMENT_DATABASE_URL from
// process.env like every other service; never hardcoded and never read from a
// .env file directly here (S4). A missing value fails the process start
// closed rather than falling back to a baked-in connection string.
function buildDbFromEnv(): FulfillmentDb {
  const datasourceUrl = process.env.FULFILLMENT_DATABASE_URL
  if (!datasourceUrl) {
    throw new Error('FULFILLMENT_DATABASE_URL is required (never defaulted in code)')
  }
  return new PrismaClient({ datasourceUrl })
}

// Deferred: nothing under test/ imports this file (index.ts exports
// runBatchingTick only), so it never runs under vitest. The loop/one-shot
// decision itself lives in runScheduler/runLoop (./loop.ts), which ARE
// covered by test/loop.test.ts with a fake tick and a fake sleep and no DB
// (fix round, Finding 2); this function is left as thin DB/process wiring
// around that tested core.
async function main(): Promise<void> {
  const db = buildDbFromEnv()
  process.once('SIGTERM', requestStop)
  process.once('SIGINT', requestStop)

  try {
    await runScheduler({
      once: process.env.SCHEDULER_ONCE === '1',
      tick: async () => {
        await runBatchingTick(db, new Date())
      },
      sleep,
      shouldStop: () => stopped,
      tickMs: TICK_SECONDS * 1000,
    })
  } finally {
    await db.$disconnect()
  }
}

// An unhandled rejection here (a missing FULFILLMENT_DATABASE_URL, a DB
// connection failure) crashes the process by Node's default, which is the
// correct fail-closed behavior for a process that cannot drive batching
// safely.
void main()
