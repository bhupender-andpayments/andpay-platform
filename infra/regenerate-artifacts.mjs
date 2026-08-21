// One-time repair: re-render the composed artifacts whose bytes were lost.
//
//   node infra/regenerate-artifacts.mjs --bucket B --prefix dev --profile P --db local   # DRY RUN
//   node infra/regenerate-artifacts.mjs --bucket B --prefix dev --profile P --db local --apply
//   ... --db rds
//
// WHY THESE ARE RECOVERABLE AT ALL. 74 composed_artifact rows point at
// references the ORIGINAL in-memory AssetStore minted and then lost on the next
// restart, so they 404 today and had nothing for the S3 migration to move. They
// come back only because collateral rendering is deterministic and the asset
// key is DERIVED from ids rather than stored: re-running the render for a batch
// puts identical bytes at exactly the key the existing row already references.
// Every dead reference is `:v1`, and its key has no object in S3, so the fresh
// put lands at v1 and the stored reference resolves with no database change.
//
// THE DATABASE IS NEVER WRITTEN. Not one row is inserted, updated or
// superseded; this only fills in missing objects. That is also why it does not
// use recomposeArtifact, which copies the prior row's asset_reference verbatim
// and would mint a second row pointing at the same missing object.
//
// IT RENDERS PER BATCH, because that is the unit the render function reads. An
// artifact in an affected batch whose bytes are already present therefore gets
// a redundant second version. That is harmless (the row keeps referencing v1,
// which still resolves, and artifacts are fetched by reference, never listed by
// version) and it is a much smaller cost than a second hand-maintained copy of
// the render's input query.
import process from 'node:process'
import console from 'node:console'

function parseArgs(argv) {
  const out = { apply: false, db: 'local' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--bucket') out.bucket = argv[++i]
    else if (a === '--prefix') out.prefix = argv[++i]
    else if (a === '--profile') out.profile = argv[++i]
    else if (a === '--region') out.region = argv[++i]
    else if (a === '--db') out.db = argv[++i]
    else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.bucket === undefined || args.prefix === undefined) {
    console.error('usage: node infra/regenerate-artifacts.mjs --bucket B --prefix dev [--profile P] [--db local|rds] [--apply]')
    process.exitCode = 2
    return
  }
  if (args.profile !== undefined) process.env.AWS_PROFILE = args.profile

  const { deriveUrls, loadEnvFile } = await import('./db-url.mjs')
  const url =
    args.db === 'rds'
      ? deriveUrls(loadEnvFile()).FULFILLMENT_DATABASE_URL
      : 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
  process.env.FULFILLMENT_DATABASE_URL = url

  const { createS3AssetStore, preRenderArtifacts } = await import('../services/fulfillment/dist/index.js')
  const { PrismaClient } = await import('../services/fulfillment/generated/client/index.js')

  const store = await createS3AssetStore({
    bucket: args.bucket,
    prefix: args.prefix,
    region: args.region ?? process.env.AWS_REGION ?? 'ap-south-1',
  })
  const db = new PrismaClient()

  console.log(`database    : ${args.db}`)
  console.log(`destination : s3://${args.bucket}/${args.prefix}/assets/`)
  console.log(`mode        : ${args.apply ? 'APPLY' : 'DRY RUN'}\n`)

  // Live rows only: a superseded row's reference is history and its successor
  // carries the same asset_reference anyway.
  const rows = await db.$queryRawUnsafe(`
    SELECT id::text AS id, asgn_id::text AS asgn_id, btch_id::text AS btch_id,
           program_id::text AS program_id, tenant_id::text AS tenant_id,
           artifact_type, asset_reference
      FROM fulfillment.composed_artifact
     WHERE superseded_by IS NULL
     ORDER BY btch_id, asgn_id, artifact_type`)

  const dead = []
  for (const r of rows) {
    if ((await store.getByReference(r.asset_reference)) === null) dead.push(r)
  }
  console.log(`${rows.length} live artifacts, ${dead.length} with missing bytes`)
  if (dead.length === 0) {
    await db.$disconnect()
    console.log('Nothing to regenerate.')
    return
  }

  // One render per affected batch. The wire btchId is recovered from the asset
  // key the row already carries, so it matches the key the render will rebuild
  // exactly, rather than being re-derived by a second encoding of that rule.
  const batches = new Map()
  for (const d of dead) {
    const wire = /dev-asset:artifact\/([^/]+)\//.exec(d.asset_reference)?.[1]
    if (wire === undefined) {
      console.log(`  SKIP ${d.id}: reference is not an artifact key (${d.asset_reference})`)
      continue
    }
    const k = `${wire}|${d.btch_id}|${d.program_id}|${d.tenant_id}`
    if (!batches.has(k)) batches.set(k, { wire, btchUuid: d.btch_id, programUuid: d.program_id, tenantUuid: d.tenant_id, count: 0 })
    batches.get(k).count += 1
  }
  console.log(`across ${batches.size} batches\n`)
  for (const b of batches.values()) console.log(`  ${b.wire}  ${b.count} to regenerate`)

  if (!args.apply) {
    await db.$disconnect()
    console.log('\nDry run. Re-run with --apply to render and store.')
    return
  }

  console.log()
  let rendered = 0
  let failed = 0
  for (const b of batches.values()) {
    try {
      const prepared = await preRenderArtifacts(
        db,
        store,
        // preRenderArtifacts reads only btchId off the payload (it builds the
        // asset key from it); the rest of BatchFactPayload is unused here.
        { btchId: b.wire, tenantId: b.tenantUuid, programId: b.programUuid, triggerReason: 'REGENERATE', unitCount: 0, asgnIds: [] },
        b.btchUuid,
        b.programUuid,
      )
      rendered += prepared.size
      console.log(`  ${b.wire}: rendered ${prepared.size} artifacts`)
    } catch (err) {
      failed += 1
      console.error(`  ${b.wire}: FAILED ${String(err.message ?? err).split('\n')[0]}`)
    }
  }

  // Prove it: re-resolve every reference that was dead a moment ago.
  let stillDead = 0
  for (const d of dead) {
    if ((await store.getByReference(d.asset_reference)) === null) {
      stillDead += 1
      console.error(`  STILL DEAD ${d.artifact_type} ${d.asset_reference}`)
    }
  }
  await db.$disconnect()

  console.log(`\nrendered ${rendered} objects across ${batches.size} batches, ${failed} batch failures`)
  console.log(`${dead.length - stillDead}/${dead.length} previously dead references now resolve`)
  if (stillDead > 0 || failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(String(err.message ?? err))
  process.exitCode = 1
})
