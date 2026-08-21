// One-time migration: upload every object in the dev filesystem asset store to
// S3, at the paths S3AssetStore reads, so that the 453 `dev-asset:` references
// already persisted in bank_composition_config and composed_artifact keep
// resolving after the adapter is switched on.
//
//   node infra/s3-migrate-assets.mjs --bucket B --prefix dev --profile P          # DRY RUN
//   node infra/s3-migrate-assets.mjs --bucket B --prefix dev --profile P --apply
//
// WHY THE PATHS MUST AGREE EXACTLY. The filesystem adapter stores
// <sha256(key)>/<version>.bin and records the logical key in a sidecar JSON.
// S3AssetStore stores <prefix>/assets/<encoded key>/<version>. The hash is not
// reversible, so the sidecar is the only thing that knows what a directory
// holds: this reads the key from there and rebuilds the S3 path with the
// adapter's own encoding rule, imported rather than reimplemented. A second
// copy of that rule would drift and the migration would land bytes the adapter
// cannot find.
//
// IT IS IDEMPOTENT AND RESUMABLE. 1.8 GB over a home connection does not
// reliably finish in one go. Every object is checked with a HEAD first and
// skipped when already present with the same size, so a re-run costs one cheap
// request per object and repairs a partial transfer.
//
// IT NEVER DELETES ANYTHING, locally or remotely. The AssetStore port's whole
// contract is that history is retained, and the local store stays untouched as
// the fallback until the switch is proven.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import console from 'node:console'

function parseArgs(argv) {
  const out = { apply: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--bucket') out.bucket = argv[++i]
    else if (a === '--prefix') out.prefix = argv[++i]
    else if (a === '--profile') out.profile = argv[++i]
    else if (a === '--region') out.region = argv[++i]
    else if (a === '--root') out.root = argv[++i]
    else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

/** Every version file in the filesystem store, with its logical key. */
function scanLocalStore(root) {
  if (!existsSync(root)) throw new Error(`no asset store at ${root}`)
  const found = []
  for (const dir of readdirSync(root)) {
    const full = join(root, dir)
    if (!statSync(full).isDirectory()) continue
    for (const entry of readdirSync(full)) {
      if (!entry.endsWith('.json')) continue
      const version = entry.slice(0, -'.json'.length)
      const bin = join(full, `${version}.bin`)
      // A sidecar with no bytes is the claimed-but-not-yet-written window the
      // fs adapter documents. Nothing to migrate, and not an error.
      if (!existsSync(bin)) continue
      const sidecar = JSON.parse(readFileSync(join(full, entry), 'utf8'))
      found.push({
        key: sidecar.key,
        version,
        meta: sidecar.meta ?? { contentType: 'application/octet-stream', filename: '' },
        path: bin,
        size: statSync(bin).size,
      })
    }
  }
  return found.sort((a, b) => (a.key === b.key ? a.version.localeCompare(b.version) : a.key.localeCompare(b.key)))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.bucket === undefined || args.prefix === undefined) {
    console.error('usage: node infra/s3-migrate-assets.mjs --bucket B --prefix dev [--profile P] [--region ap-south-1] [--root DIR] [--apply]')
    process.exitCode = 2
    return
  }
  const root = args.root ?? process.env.ANDPAY_ASSET_DIR ?? join(tmpdir(), 'andpay-asset-store')
  const region = args.region ?? process.env.AWS_REGION ?? 'ap-south-1'

  // The adapter's own layout rule, imported rather than reimplemented so the
  // migration cannot write somewhere a read will not look.
  const { s3ObjectKey } = await import('../services/fulfillment/dist/storage/s3-asset-store.js')
  // The profile is handed to the SDK through its own environment variable, so
  // credential resolution stays the default chain and this script never reads
  // a credential itself (S4).
  if (args.profile !== undefined) process.env.AWS_PROFILE = args.profile
  const { S3Client, PutObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3')
  const client = new S3Client({ region })
  const objectKeyFor = (key, version) => s3ObjectKey(args.prefix, key, version)

  const items = scanLocalStore(root)
  const totalBytes = items.reduce((n, i) => n + i.size, 0)
  console.log(`local store : ${root}`)
  console.log(`objects     : ${items.length}  (${(totalBytes / 1e6).toFixed(0)} MB)`)
  console.log(`destination : s3://${args.bucket}/${args.prefix}/assets/  in ${region}`)
  console.log(`mode        : ${args.apply ? 'APPLY' : 'DRY RUN'}\n`)

  let uploaded = 0
  let skipped = 0
  let failed = 0
  let sentBytes = 0

  for (const [index, item] of items.entries()) {
    const objectKey = objectKeyFor(item.key, item.version)
    let present = false
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: args.bucket, Key: objectKey }))
      present = head.ContentLength === item.size
    } catch {
      present = false
    }
    if (present) {
      skipped += 1
      continue
    }
    if (!args.apply) {
      if (uploaded < 5) console.log(`  would upload  ${objectKey}  (${(item.size / 1e6).toFixed(1)} MB)`)
      uploaded += 1
      continue
    }
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: args.bucket,
          Key: objectKey,
          Body: readFileSync(item.path),
          ContentType: item.meta.contentType,
          Metadata: { filename: encodeURIComponent(item.meta.filename ?? '') },
          // No IfNoneMatch: a resumed run legitimately rewrites an object whose
          // size did not match, and the source of truth here is the local file.
        }),
      )
      uploaded += 1
      sentBytes += item.size
      if (uploaded % 25 === 0 || index === items.length - 1) {
        console.log(`  ${uploaded} uploaded, ${skipped} already present, ${(sentBytes / 1e6).toFixed(0)} MB sent`)
      }
    } catch (err) {
      failed += 1
      console.error(`  FAILED ${objectKey}: ${String(err.message ?? err).split('\n')[0]}`)
    }
  }

  console.log(
    `\n${args.apply ? 'uploaded' : 'would upload'}: ${uploaded}   already present: ${skipped}   failed: ${failed}`,
  )
  if (!args.apply) console.log('\nDry run. Re-run with --apply to transfer.')
  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(String(err.message ?? err))
  process.exitCode = 1
})
