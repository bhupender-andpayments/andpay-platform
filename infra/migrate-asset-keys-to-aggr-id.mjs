// One-time DATA migration: move every aggregator's artwork from CODE-stemmed
// asset keys to ID-stemmed ones (ruled 24 Aug 2026).
//
//   node infra/migrate-asset-keys-to-aggr-id.mjs --bucket B --prefix dev --profile P          # DRY RUN
//   node infra/migrate-asset-keys-to-aggr-id.mjs --bucket B --prefix dev --profile P --apply
//
// WHY. The 24 Aug renumbering proved the cost of keying artwork on the
// aggregator CODE: correcting 90 codes meant replaying every version of every
// key. The aggregator's wire `aggr_` id never changes, so keys stemmed on it
// survive any future code correction untouched. From this ruling on,
// setBankLogoPair and setBankBanner key on args.assetKey (the aggr id) and
// the ops-edge read routes list under the id; this script moves what the
// code-keyed era already stored.
//
// WHAT MOVES. For each aggregator: `<code>` -> `<aggrId>`,
// `<code>:derivative` -> `<aggrId>:derivative`, `<code>:banner` ->
// `<aggrId>:banner`, version numbering preserved (replayKey refuses a
// mismatch). Config-row refs are then rewritten by swapping the key stem
// inside the stored reference, which is exact BECAUSE the version tokens
// survived. Old objects stay: references already persisted elsewhere (for
// example composed_artifact's own artifact keys, which never carried a bank
// code stem) keep resolving, per the AssetStore port contract.
//
// WHAT DOES NOT MOVE. The tenant-level template keys (template/<group>/...)
// are not aggregator assets and keep their shape. The legacy 'HDFC' config
// row has no aggregator to take its key, and setBankLogo's bankCode/branch
// keys remain the legacy tenant-keyed surface; both are reported, not moved.
//
// LOCAL ONLY, like its three siblings: the shared RDS dataset is never
// rewritten by a script (CLAUDE.md, "SCHEMA ONLY").
import process from 'node:process'
import console from 'node:console'
import { URL } from 'node:url'

const SUFFIXES = ['', ':derivative', ':banner']

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
const LOCAL_IDENTITY = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity'

/** Same replay as renumber-aggregator-codes.mjs: version-for-version, resumable. */
async function replayKey(store, oldKey, newKey, apply) {
  const versions = await store.listVersions(oldKey)
  if (versions.length === 0) return { copied: 0 }
  versions.sort((a, b) => Number(a.version.slice(1)) - Number(b.version.slice(1)))
  if (!apply) return { copied: versions.length }
  const existing = (await store.listVersions(newKey)).length
  for (let i = 0; i < versions.length; i += 1) {
    if (i < existing) continue
    const rec = await store.getByReference(versions[i].reference)
    if (rec === null) throw new Error(`${oldKey} ${versions[i].version} does not resolve; refusing to lose a version`)
    const put = await store.put(newKey, rec.bytes, { contentType: rec.meta.contentType, filename: rec.meta.filename })
    if (put.version !== versions[i].version) {
      throw new Error(`${newKey} landed at ${put.version} but ${oldKey} had ${versions[i].version}`)
    }
  }
  return { copied: versions.length }
}

/** Swap the key stem inside a stored reference, exact because versions survived. */
function rewriteRef(ref, oldKey, newKey) {
  if (ref === null) return null
  const m = /^(dev-asset|s3-asset):(.*):(v\d+)$/.exec(ref)
  if (m === null) return null
  if (m[2] !== oldKey && !m[2].startsWith(`${oldKey}:`)) return null
  return `s3-asset:${m[2] === oldKey ? newKey : newKey + m[2].slice(oldKey.length)}:${m[3]}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.bucket === undefined || args.prefix === undefined) {
    console.error('usage: node infra/migrate-asset-keys-to-aggr-id.mjs --bucket B --prefix dev [--profile P] [--region R] [--apply]')
    process.exitCode = 2
    return
  }
  if (args.profile !== undefined) process.env.AWS_PROFILE = args.profile

  for (const url of [LOCAL_FULFILLMENT, LOCAL_IDENTITY]) {
    const host = new URL(url).hostname
    if (host !== 'localhost' && host !== '127.0.0.1') {
      console.error(`REFUSING: ${host} is not local docker.`)
      process.exitCode = 1
      return
    }
  }
  process.env.FULFILLMENT_DATABASE_URL = LOCAL_FULFILLMENT

  const { createS3AssetStore } = await import('../services/fulfillment/dist/index.js')
  const { PrismaClient: FulfillmentClient } = await import('../services/fulfillment/generated/client/index.js')
  const { PrismaClient: IdentityClient } = await import('../services/identity/generated/client/index.js')
  const { fromUuid } = await import('../packages/ids/dist/index.js')

  const store = await createS3AssetStore({
    bucket: args.bucket,
    prefix: args.prefix,
    region: args.region ?? process.env.AWS_REGION ?? 'ap-south-1',
  })
  const fdb = new FulfillmentClient({ datasourceUrl: LOCAL_FULFILLMENT })
  const idb = new IdentityClient({ datasourceUrl: LOCAL_IDENTITY })

  console.log(`database    : LOCAL docker (andpay)`)
  console.log(`assets      : s3://${args.bucket}/${args.prefix}/assets/`)
  console.log(`mode        : ${args.apply ? 'APPLY' : 'DRY RUN'}\n`)

  const aggregators = await idb.$queryRawUnsafe(
    `SELECT id::text AS id, tenant_id::text AS tenant_id, aggregator_code FROM identity.aggregator ORDER BY aggregator_code`,
  )

  let moved = 0
  for (const a of aggregators) {
    const aggrId = fromUuid('aggr', a.id)
    const copies = []
    for (const suffix of SUFFIXES) {
      const r = await replayKey(store, `${a.aggregator_code}${suffix}`, `${aggrId}${suffix}`, args.apply)
      if (r.copied > 0) copies.push(`${suffix === '' ? 'master' : suffix.slice(1)}:${r.copied}`)
    }
    if (copies.length === 0) continue
    moved += 1

    if (args.apply) {
      const rows = await fdb.$queryRawUnsafe(
        `SELECT id::text AS id, logo_master_ref, logo_derivative_ref, header_banner_ref
           FROM fulfillment.bank_composition_config
          WHERE tenant_id = $1::uuid AND bank_code = $2 AND branch_code = ''`,
        a.tenant_id,
        a.aggregator_code,
      )
      for (const row of rows) {
        const master = rewriteRef(row.logo_master_ref, a.aggregator_code, aggrId)
        const derivative = rewriteRef(row.logo_derivative_ref, a.aggregator_code, aggrId)
        const banner = rewriteRef(row.header_banner_ref, a.aggregator_code, aggrId)
        await fdb.$executeRawUnsafe(
          `UPDATE fulfillment.bank_composition_config
              SET logo_master_ref = COALESCE($1, logo_master_ref),
                  logo_derivative_ref = COALESCE($2, logo_derivative_ref),
                  header_banner_ref = COALESCE($3, header_banner_ref),
                  updated_at = now()
            WHERE id = $4::uuid`,
          master,
          derivative,
          banner,
          row.id,
        )
      }
    }
    console.log(`  ${a.aggregator_code} -> ${aggrId}: ${copies.join(', ')}`)
  }
  console.log(`\n${moved} aggregator(s) with artwork ${args.apply ? 'moved' : 'to move'}`)

  if (!args.apply) {
    console.log(`\nDRY RUN: nothing written. Re-run with --apply.`)
    await Promise.all([fdb.$disconnect(), idb.$disconnect()])
    return
  }

  // VERIFY: every config ref resolves, and every aggregator with artwork
  // answers getCurrent under its ID key (the exact read the edge now runs).
  console.log(`\nverifying...`)
  let bad = 0
  const cfgRows = await fdb.$queryRawUnsafe(
    `SELECT bank_code, logo_master_ref, logo_derivative_ref, header_banner_ref
       FROM fulfillment.bank_composition_config`,
  )
  for (const r of cfgRows) {
    for (const ref of [r.logo_master_ref, r.logo_derivative_ref, r.header_banner_ref]) {
      if (ref === null) continue
      if ((await store.getByReference(ref)) === null) {
        console.error(`  ${r.bank_code}: ${ref} does not resolve`)
        bad += 1
      }
    }
  }
  for (const a of aggregators) {
    const aggrId = fromUuid('aggr', a.id)
    const hadMaster = (await store.listVersions(a.aggregator_code)).length > 0
    if (hadMaster && (await store.getCurrent(aggrId)) === null) {
      console.error(`  ${a.aggregator_code}: getCurrent(${aggrId}) finds nothing (the portal thumbnail would be blank)`)
      bad += 1
    }
  }
  console.log(bad === 0 ? `  all references and ID keys resolve.` : `  ${bad} problem(s).`)
  await Promise.all([fdb.$disconnect(), idb.$disconnect()])
  if (bad > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(String(err.stack ?? err.message ?? err))
  process.exitCode = 1
})
