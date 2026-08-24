// Recalibrate the standee-frame overlay geometry on the tenant default row,
// then re-render every demo batch so the stored artifacts pick it up.
//
//   node infra/recalibrate-overlay.mjs --bucket B --prefix dev --profile P          # DRY RUN
//   node infra/recalibrate-overlay.mjs --bucket B --prefix dev --profile P --apply
//
// WHY A SEPARATE SCRIPT. Spacing is tuned by eye against printed output, so
// it changes more often than the frame or the banners; re-running
// apply-standee-frame for a two-number tweak would mint pointless new asset
// versions of all 87 banners and the template. This writes ONLY the overlay
// GEOMETRY keys (merging into the existing image_templates so flags like
// overlay.marks survive) and re-renders.
//
// THE VALUES ARE THE ONES IN infra/apply-standee-frame.mjs. This script reads
// them from there rather than carrying a second copy, so the two can never
// disagree about what calibration is current.
//
// LOCAL ONLY, like its siblings (CLAUDE.md, "SCHEMA ONLY" for the shared RDS).
import process from 'node:process'
import console from 'node:console'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'

// The single source of the calibration: parse the OVERLAY literal out of the
// apply script. A regex-extracted eval of one const is crude but honest; the
// alternative (a shared .mjs constants module) is warranted the day a third
// consumer appears.
function loadOverlay() {
  const src = readFileSync(new URL('./apply-standee-frame.mjs', import.meta.url), 'utf8')
  const m = /const OVERLAY = (\{[\s\S]*?\n\})/.exec(src)
  if (m === null) throw new Error('could not find the OVERLAY literal in apply-standee-frame.mjs')
  return new Function(`return ${m[1]}`)()
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.bucket === undefined || args.prefix === undefined) {
    console.error('usage: node infra/recalibrate-overlay.mjs --bucket B --prefix dev [--profile P] [--region R] [--apply]')
    process.exitCode = 2
    return
  }
  if (args.profile !== undefined) process.env.AWS_PROFILE = args.profile
  if (new URL(LOCAL_FULFILLMENT).hostname !== 'localhost') {
    console.error('REFUSING: not local docker.')
    process.exitCode = 1
    return
  }
  process.env.FULFILLMENT_DATABASE_URL = LOCAL_FULFILLMENT

  const { createS3AssetStore, preRenderArtifacts } = await import('../services/fulfillment/dist/index.js')
  const { PrismaClient: FulfillmentClient } = await import('../services/fulfillment/generated/client/index.js')
  const { fromUuid } = await import('../packages/ids/dist/index.js')
  const store = await createS3AssetStore({
    bucket: args.bucket,
    prefix: args.prefix,
    region: args.region ?? process.env.AWS_REGION ?? 'ap-south-1',
  })
  const fdb = new FulfillmentClient({ datasourceUrl: LOCAL_FULFILLMENT })

  const OVERLAY = loadOverlay()
  console.log(`mode        : ${args.apply ? 'APPLY' : 'DRY RUN'}`)
  console.log(`calibration : name ${OVERLAY.name.yFrac}, legal ${OVERLAY.legal.yFrac}, qr ${OVERLAY.qr.yFrac}/${OVERLAY.qr.sideFrac}, vpa ${OVERLAY.vpa.yFrac}, banner ${OVERLAY.banner.yFrac}\n`)

  // Only the LIVE tenant's default row: an orphaned seed tenant also left a
  // ('','') row behind (dead fixture refs, tenant deleted), and writing the
  // calibration onto it would dress junk up as configuration.
  const { PrismaClient: IdentityClient } = await import('../services/identity/generated/client/index.js')
  const idb = new IdentityClient({ datasourceUrl: 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity' })
  const tenants = await idb.$queryRawUnsafe(`SELECT id::text AS id FROM identity.tenant`)
  await idb.$disconnect()
  const tenantIds = tenants.map((t) => t.id)
  const rows = (
    await fdb.$queryRawUnsafe(
      `SELECT id::text AS id, tenant_id::text AS tenant_id, image_templates
         FROM fulfillment.bank_composition_config WHERE bank_code = '' AND branch_code = ''`,
    )
  ).filter((r) => tenantIds.includes(r.tenant_id))
  if (rows.length === 0) {
    console.error('REFUSING: no tenant default row; run infra/apply-standee-frame.mjs first.')
    process.exitCode = 1
    return
  }
  for (const row of rows) {
    const current = row.image_templates ?? {}
    const next = { ...current }
    for (const type of ['SOUNDBOX', 'STANDEE', 'STICKER']) {
      const entry = typeof next[type] === 'object' && next[type] !== null ? { ...next[type] } : {}
      const overlay = typeof entry.overlay === 'object' && entry.overlay !== null ? { ...entry.overlay } : {}
      // Geometry only; anything else under overlay (marks, future keys) is kept.
      for (const k of ['name', 'legal', 'qr', 'vpa', 'banner']) overlay[k] = OVERLAY[k]
      entry.overlay = overlay
      next[type] = entry
    }
    if (args.apply) {
      await fdb.$executeRawUnsafe(
        `UPDATE fulfillment.bank_composition_config SET image_templates = $1::jsonb, updated_at = now() WHERE id = $2::uuid`,
        JSON.stringify(next),
        row.id,
      )
    }
    console.log(`default row ${row.id}: overlay geometry ${args.apply ? 'written' : 'would be written'}`)
  }

  if (!args.apply) {
    console.log('\nDRY RUN: nothing written. Re-run with --apply.')
    await fdb.$disconnect()
    return
  }

  // Re-render, same pattern as the siblings: rows move to the new reference.
  const affected = await fdb.$queryRawUnsafe(
    `SELECT DISTINCT p.batch::text AS btch_uuid, p.program_id::text AS program_id, p.tenant_id::text AS tenant_id
       FROM fulfillment.pending_pool_entry p WHERE p.batch IS NOT NULL`,
  )
  console.log(`\nre-rendering ${affected.length} batch(es)`)
  let repointed = 0
  let failed = 0
  for (const b of affected) {
    const wireRows = await fdb.$queryRawUnsafe(
      `SELECT asset_reference FROM fulfillment.composed_artifact
        WHERE btch_id = $1::uuid AND superseded_by IS NULL LIMIT 1`,
      b.btch_uuid,
    )
    const wire = /:artifact\/([^/]+)\//.exec(wireRows[0]?.asset_reference ?? '')?.[1]
    if (wire === undefined) continue
    try {
      const prepared = await preRenderArtifacts(
        fdb,
        store,
        // The fact payload carries WIRE ids (batching.ts emits tenantWire), and
        // preRenderArtifacts now converts tenantId via toUuid, so the raw column
        // value must be wrapped first.
        { btchId: wire, tenantId: fromUuid('tnnt', b.tenant_id), programId: b.program_id, triggerReason: 'RECALIBRATE', unitCount: 0, asgnIds: [] },
        b.btch_uuid,
        b.program_id,
      )
      for (const [k, v] of prepared) {
        const [asgnUuid, artifactType] = k.split('|')
        repointed += await fdb.$executeRawUnsafe(
          `UPDATE fulfillment.composed_artifact SET asset_reference = $1
            WHERE btch_id = $2::uuid AND asgn_id = $3::uuid AND artifact_type = $4 AND superseded_by IS NULL`,
          v.reference,
          b.btch_uuid,
          asgnUuid,
          artifactType,
        )
      }
      console.log(`  ${wire}: rendered ${prepared.size}`)
    } catch (err) {
      failed += 1
      console.error(`  ${wire}: FAILED ${String(err.message ?? err).split('\n')[0]}`)
    }
  }
  console.log(`\nrepointed ${repointed} artifact row(s), ${failed} failure(s)`)
  await fdb.$disconnect()
  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(String(err.stack ?? err.message ?? err))
  process.exitCode = 1
})
