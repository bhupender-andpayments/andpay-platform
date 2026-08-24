// Close the projection gap 20260820120000_backfill_default_aggregators left:
// a tenant's default aggregator inserted by SQL, with no fact behind it, that
// TMS therefore never projected.
//
//   node infra/announce-default-aggregators.mjs            # DRY RUN
//   node infra/announce-default-aggregators.mjs --apply
//
// It enqueues identity's own fact and nothing else. It does NOT write
// tms.aggregator_projection: the relay publishes the outbox row and the tms
// consumer projects it, which is the only path allowed to touch another
// context's tables (C4, T7). Its sibling repair scripts write both schemas
// directly because they rewrite demo data in place; this one is announcing a
// fact that should always have existed, so it uses the real rail.
//
// THE RAIL MUST BE RUNNING for the projection to appear. Under the demo stack
// that is docs/plan/phase7_demo/harness/rail.mjs (relay plus the four
// consumers), which `scripts/demo.sh` boots. Without it the outbox row is
// still correct and simply waits.
//
// Safe to re-run: announceDefaultAggregators gates each enqueue on
// stepKey(aggrId, 'announce-default') through identity's inbox, so a second
// run enqueues nothing. See services/identity/src/announce.ts.
//
// LOCAL ONLY, like every script in this directory. The shared RDS data is
// never touched by a script (CLAUDE.md, "SCHEMA ONLY. The shared data is never
// touched"); that instance needs its own explicit decision.
import process from 'node:process'
import console from 'node:console'
import { URL } from 'node:url'

const LOCAL_IDENTITY = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity'
const LOCAL_TMS = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'

function parseArgs(argv) {
  const out = { apply: false }
  for (const a of argv) {
    if (a === '--apply') out.apply = true
    else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  for (const url of [LOCAL_IDENTITY, LOCAL_TMS]) {
    const host = new URL(url).hostname
    if (host !== 'localhost' && host !== '127.0.0.1') {
      console.error(`REFUSING: ${host} is not local docker.`)
      process.exitCode = 1
      return
    }
  }

  const { announceDefaultAggregators } = await import('../services/identity/dist/index.js')
  const { PrismaClient: IdentityClient } = await import('../services/identity/generated/client/index.js')
  const { PrismaClient: TmsClient } = await import('../services/tms/generated/client/index.js')

  const idb = new IdentityClient({ datasourceUrl: LOCAL_IDENTITY })
  const tdb = new TmsClient({ datasourceUrl: LOCAL_TMS })

  console.log('database : LOCAL docker (andpay)')
  console.log(`mode     : ${args.apply ? 'APPLY' : 'DRY RUN'}\n`)

  try {
    const defaults = await idb.$queryRawUnsafe(`
      SELECT a.id::text AS id, a.aggregator_code, a.display_name, t.display_name AS tenant_name
      FROM aggregator a JOIN tenant t ON t.id = a.tenant_id
      WHERE a.is_default
      ORDER BY a.aggregator_code
    `)
    const projected = await tdb.$queryRawUnsafe(
      `SELECT id::text AS id FROM aggregator_projection`,
    )
    const known = new Set(projected.map((r) => r.id))
    const missing = defaults.filter((d) => !known.has(d.id))

    console.log(`default aggregators : ${defaults.length}`)
    console.log(`unprojected in tms  : ${missing.length}`)
    for (const m of missing) {
      console.log(`  ${m.aggregator_code}  ${m.display_name}  (bank ${m.tenant_name})`)
    }
    console.log('')

    if (!args.apply) {
      console.log('DRY RUN. Re-run with --apply to announce every default aggregator.')
      console.log('The announcement is idempotent, so already-projected defaults cost one no-op fact each.')
      return
    }

    const res = await announceDefaultAggregators(idb, { traceId: 'infra-announce-default-aggregators' })
    console.log(`announced        : ${res.announced.length}`)
    for (const a of res.announced) console.log(`  ${a.aggregatorCode}  ${a.aggrId}`)
    console.log(`already announced: ${res.alreadyAnnounced}`)
    console.log('\nThe relay publishes these and the tms consumer projects them.')
    console.log('Verify with: select count(*) from tms.aggregator_projection;')
  } finally {
    await idb.$disconnect()
    await tdb.$disconnect()
  }
}

await main()
