// One-time DATA repair of the local demo dataset: repoint its batches from the
// placeholder numeric bank codes onto real imported aggregator codes, then
// re-render their collateral so each card carries that aggregator's own logo.
//
//   node infra/repoint-demo-bank-codes.mjs --bucket B --prefix dev --profile P          # DRY RUN
//   node infra/repoint-demo-bank-codes.mjs --bucket B --prefix dev --profile P --apply
//
// WHY IT IS NEEDED. The demo dataset was seeded before the 93-bank import, so
// its assignments carry bank_reference_code values of '17', '9' and '3' and a
// bank_display_name of '3'. bank_composition_config is keyed on aggregator
// CODES ('ADC-BANK', ...), so the config lookup missed every row, fell through
// to the tenant-level default, and found that row's two dead fixture logo
// references. The renderer therefore drew its no-logo fallback for every
// merchant in the demo, and the proof honestly showed it.
//
// THIS SCRIPT WRITES DEMO DATA ON PURPOSE. It is the one tool here that does.
// It is scoped to LOCAL docker only and refuses any other host: the shared RDS
// dataset is never repointed by a script (CLAUDE.md, "SCHEMA ONLY, the shared
// data is never touched"), and doing it there is a separate, explicit decision.
//
// WHAT bank_display_name BECOMES, AND WHY IT IS NOT THE AGGREGATOR'S NAME.
// services/tms/src/assignment.ts writes bank_reference_code from the request
// row's own tenant_reference (the AGGREGATOR) and bank_display_name from the
// TENANT projection's display_name (the bank partner). So the correct pair here
// is the aggregator code plus the tenant's name, not the aggregator's name
// twice. Copying the aggregator's display name in would look right on screen
// and be wrong against the only code that writes these columns for real.
//
// THE ARTIFACT REFERENCE MUST BE REPOINTED, NOT JUST RE-RENDERED. The asset key
// is derived (artifact/<btchId>/<asgnId>/<type>), so a re-render PUTS A NEW
// VERSION at the same key: the fresh bytes land at v2 while every
// composed_artifact row still references v1, which still resolves to the old
// logo-less PDF. Re-rendering alone would therefore change nothing an operator
// can see, and would report success. So each row is updated to the reference
// the render returns. That is the opposite of infra/regenerate-artifacts.mjs,
// which deliberately writes no rows because there the bytes were MISSING and
// the existing v1 reference was the one to fill in.
import process from 'node:process'
import console from 'node:console'
import { URL } from 'node:url'

// Placeholder code -> the real aggregator code to adopt. Each target exists in
// identity.aggregator and carries a live logo in bank_composition_config, so
// the re-render has artwork to embed. Chosen to keep the demo's shape (three
// distinct banks across the pooled merchants) rather than collapsing them onto
// one.
const MAPPING = {
  '17': 'ADC-BANK',
  '9': 'AMRELI-DISTRICT-CENTRAL-CO-OP-BANK',
  '3': 'GODHRA-CITY-CO-OP-BANK',
}

function parseArgs(argv) {
  const out = { apply: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--bucket') out.bucket = argv[++i]
    else if (a === '--prefix') out.prefix = argv[++i]
    else if (a === '--profile') out.profile = argv[++i]
    else if (a === '--region') out.region = argv[++i]
    else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

const LOCAL_FULFILLMENT = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const LOCAL_TMS = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const LOCAL_IDENTITY = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.bucket === undefined || args.prefix === undefined) {
    console.error(
      'usage: node infra/repoint-demo-bank-codes.mjs --bucket B --prefix dev [--profile P] [--region R] [--apply]',
    )
    process.exitCode = 2
    return
  }
  if (args.profile !== undefined) process.env.AWS_PROFILE = args.profile

  // LOCAL ONLY, and not negotiable: this rewrites demo rows.
  for (const url of [LOCAL_FULFILLMENT, LOCAL_TMS, LOCAL_IDENTITY]) {
    const host = new URL(url).hostname
    if (host !== 'localhost' && host !== '127.0.0.1') {
      console.error(`REFUSING: ${host} is not local docker.`)
      process.exitCode = 1
      return
    }
  }
  process.env.FULFILLMENT_DATABASE_URL = LOCAL_FULFILLMENT

  const { createS3AssetStore, preRenderArtifacts } = await import('../services/fulfillment/dist/index.js')
  const { PrismaClient: FulfillmentClient } = await import('../services/fulfillment/generated/client/index.js')
  const { PrismaClient: TmsClient } = await import('../services/tms/generated/client/index.js')
  const { PrismaClient: IdentityClient } = await import('../services/identity/generated/client/index.js')

  const store = await createS3AssetStore({
    bucket: args.bucket,
    prefix: args.prefix,
    region: args.region ?? process.env.AWS_REGION ?? 'ap-south-1',
  })
  const fdb = new FulfillmentClient({ datasourceUrl: LOCAL_FULFILLMENT })
  const tdb = new TmsClient({ datasourceUrl: LOCAL_TMS })
  const idb = new IdentityClient({ datasourceUrl: LOCAL_IDENTITY })

  console.log(`database    : LOCAL docker (andpay)`)
  console.log(`assets      : s3://${args.bucket}/${args.prefix}/assets/`)
  console.log(`mode        : ${args.apply ? 'APPLY' : 'DRY RUN'}\n`)

  // The tenant's own display name is what bank_display_name must carry.
  const tenants = await idb.$queryRawUnsafe(`SELECT display_name FROM identity.tenant ORDER BY created_at LIMIT 1`)
  const tenantName = tenants[0]?.display_name
  if (tenantName === undefined) {
    console.error('REFUSING: no tenant in identity, so bank_display_name has no correct value.')
    process.exitCode = 1
    return
  }
  console.log(`tenant name : ${tenantName}  (bank_display_name for every repointed row)\n`)

  // Every target must really exist and really have a logo, or the re-render
  // would draw the same fallback and this would be motion without effect.
  let unusable = 0
  for (const [from, to] of Object.entries(MAPPING)) {
    const aggr = await idb.$queryRawUnsafe(
      `SELECT display_name FROM identity.aggregator WHERE aggregator_code = $1 LIMIT 1`,
      to,
    )
    const cfg = await fdb.$queryRawUnsafe(
      `SELECT logo_derivative_ref, logo_master_ref FROM fulfillment.bank_composition_config
         WHERE bank_code = $1 AND branch_code = '' LIMIT 1`,
      to,
    )
    const ref = cfg[0]?.logo_derivative_ref ?? cfg[0]?.logo_master_ref ?? null
    const resolves = ref === null ? false : (await store.getByReference(ref)) !== null
    const assignments = await tdb.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM tms.assignment WHERE bank_reference_code = $1`,
      from,
    )
    const pool = await fdb.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM fulfillment.pending_pool_entry WHERE bank_reference_code = $1`,
      from,
    )
    const ok = aggr.length > 0 && resolves
    if (!ok) unusable += 1
    console.log(
      `  ${from} -> ${to}\n` +
        `      aggregator exists: ${aggr.length > 0 ? `yes (${aggr[0].display_name})` : 'NO'}` +
        `   logo resolves: ${resolves ? 'yes' : 'NO'}\n` +
        `      rows: ${assignments[0].n} assignment, ${pool[0].n} pool entries`,
    )
  }
  if (unusable > 0) {
    console.error(`\nREFUSING: ${unusable} target(s) are missing or have no resolvable logo.`)
    await Promise.all([fdb.$disconnect(), tdb.$disconnect(), idb.$disconnect()])
    process.exitCode = 1
    return
  }

  // The batches whose collateral will need re-rendering afterwards.
  const affected = await fdb.$queryRawUnsafe(
    `SELECT DISTINCT p.batch::text AS btch_uuid, p.program_id::text AS program_id, p.tenant_id::text AS tenant_id
       FROM fulfillment.pending_pool_entry p
      WHERE p.bank_reference_code = ANY($1) AND p.batch IS NOT NULL`,
    Object.keys(MAPPING),
  )
  console.log(`\n${affected.length} batch(es) will need their collateral re-rendered.`)

  if (!args.apply) {
    await Promise.all([fdb.$disconnect(), tdb.$disconnect(), idb.$disconnect()])
    console.log('\nDry run. Re-run with --apply to repoint and re-render.')
    return
  }

  // ---- 0. Make the TMS tenant projection agree with identity ---------------
  // WHY THIS IS PART OF THE FIX, not a bonus. assignment.ts derives a new row's
  // bank_display_name from tms.tenant_projection.display_name. The demo's
  // projection still held the pre-rename '3', so repointing only the existing
  // rows would leave the NEXT bank-file upload minting '3' all over again and
  // this whole repair would look like it had silently come undone.
  //
  // A projection is meant to be rebuildable from its source, and the
  // architectural route is replaying the identity tenant fact
  // (CONSUMER_FROM_BEGINNING=1). This corrects the two columns directly
  // instead, which is appropriate for an out-of-band demo-data repair and is
  // why this script lives in infra/ rather than in any product path: no
  // product code reads across contexts (C4), and this tool holds a separate
  // client per schema precisely so it is never mistaken for one that does.
  const tp = await idb.$queryRawUnsafe(`SELECT id::text AS id, display_name, bank_reference_code FROM identity.tenant`)
  console.log('\nrefreshing the TMS tenant projection from identity')
  for (const t of tp) {
    const n = await tdb.$executeRawUnsafe(
      `UPDATE tms.tenant_projection SET display_name = $1, bank_reference_code = $2, updated_at = now()
        WHERE id = $3::uuid AND (display_name <> $1 OR bank_reference_code <> $2)`,
      t.display_name,
      t.bank_reference_code,
      t.id,
    )
    console.log(`  ${t.display_name} (${t.bank_reference_code}): ${n} row(s) corrected`)
  }

  // ---- 1. Repoint the codes, in both the TMS source and the pool snapshot ----
  console.log('\nrepointing codes')
  for (const [from, to] of Object.entries(MAPPING)) {
    const a = await tdb.$executeRawUnsafe(
      `UPDATE tms.assignment SET bank_reference_code = $1, bank_display_name = $2, updated_at = now()
        WHERE bank_reference_code = $3`,
      to,
      tenantName,
      from,
    )
    const p = await fdb.$executeRawUnsafe(
      `UPDATE fulfillment.pending_pool_entry SET bank_reference_code = $1, bank_display_name = $2, updated_at = now()
        WHERE bank_reference_code = $3`,
      to,
      tenantName,
      from,
    )
    console.log(`  ${from} -> ${to}: ${a} assignment, ${p} pool entries`)
  }

  // ---- 2. Re-render each affected batch AND repoint its artifact rows -------
  // The render puts a NEW version at the derived key; the rows must move to it
  // or they keep serving the old logo-less bytes. See the header.
  console.log('\nre-rendering collateral')
  let repointed = 0
  let failed = 0
  for (const b of affected) {
    const wireRows = await fdb.$queryRawUnsafe(
      `SELECT asset_reference FROM fulfillment.composed_artifact
        WHERE btch_id = $1::uuid AND superseded_by IS NULL LIMIT 1`,
      b.btch_uuid,
    )
    const wire = /:artifact\/([^/]+)\//.exec(wireRows[0]?.asset_reference ?? '')?.[1]
    if (wire === undefined) {
      console.log(`  ${b.btch_uuid}: no artifact rows to repoint, skipped`)
      continue
    }
    try {
      const prepared = await preRenderArtifacts(
        fdb,
        store,
        { btchId: wire, tenantId: b.tenant_id, programId: b.program_id, triggerReason: 'REPOINT', unitCount: 0, asgnIds: [] },
        b.btch_uuid,
        b.program_id,
      )
      for (const [k, v] of prepared) {
        const [asgnUuid, artifactType] = k.split('|')
        const n = await fdb.$executeRawUnsafe(
          `UPDATE fulfillment.composed_artifact SET asset_reference = $1
            WHERE btch_id = $2::uuid AND asgn_id = $3::uuid AND artifact_type = $4 AND superseded_by IS NULL`,
          v.reference,
          b.btch_uuid,
          asgnUuid,
          artifactType,
        )
        repointed += n
      }
      console.log(`  ${wire}: rendered ${prepared.size}, repointed rows`)
    } catch (err) {
      failed += 1
      console.error(`  ${wire}: FAILED ${String(err.message ?? err).split('\n')[0]}`)
    }
  }

  // ---- 3. Prove it: every live reference resolves, and carries a logo -------
  const live = await fdb.$queryRawUnsafe(
    `SELECT asset_reference FROM fulfillment.composed_artifact WHERE superseded_by IS NULL`,
  )
  let resolved = 0
  for (const r of live) if ((await store.getByReference(r.asset_reference)) !== null) resolved += 1

  console.log(`\nrepointed ${repointed} artifact row(s), ${failed} batch failure(s)`)
  console.log(`${resolved}/${live.length} live artifact references resolve`)
  await Promise.all([fdb.$disconnect(), tdb.$disconnect(), idb.$disconnect()])
  if (failed > 0 || resolved !== live.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(String(err.stack ?? err.message ?? err))
  process.exitCode = 1
})
