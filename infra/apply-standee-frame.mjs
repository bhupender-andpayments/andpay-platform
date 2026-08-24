// One-time DATA load of the product team's standee QR frame (24 Aug 2026):
// the shared template, the per-bank co-brand header banners, and the overlay
// calibration that places the variable data inside that frame. Then re-render
// every demo batch so the stored artifacts show the finished card.
//
//   node infra/apply-standee-frame.mjs --dir "<folder>" --bucket B --prefix dev --profile P          # DRY RUN
//   node infra/apply-standee-frame.mjs --dir "<folder>" --bucket B --prefix dev --profile P --apply
//
// WHAT THE FOLDER IS. "AND Srandee QR Frame/" is shared by the product team:
// New Size.png is the ONE approved frame used for every bank (2260 x 4176 at
// 600 dpi, so a 271.2 x 501.12 pt trim), with the variable regions blank; and
// Bank/<code>.png are 89 finished co-brand header strips ("<bank lockup> |
// Powered By GSC BANK"), NAMED BY THE BANK'S NUMERIC AGGREGATOR CODE. The
// renderer overlays banner + merchant name + QR + UPI ID onto the frame
// (services/fulfillment/src/collateral/renderer.ts, master path).
//
// ORDER MATTERS: infra/renumber-aggregator-codes.mjs must have been applied
// first, because everything here keys on the numeric codes. This script
// refuses to run when the codes are still slugs.
//
// WHY THE TEMPLATE LANDS ON THE TENANT DEFAULT ROW. dispatch.ts resolves
// template-shaped fields per-field down to the ('','') default config row
// (templateRefWithDefault), so ONE upload covers every bank and a bank that
// later uploads its own master still overrides. The same frame is stored for
// BOTH delivery groups (ruled 24 Aug 2026), which keeps the one-trim
// guarantee intact by construction.
//
// ALIASES IN THE FOLDER, resolved by reading the artwork: 19483.png is GSC
// Bank's own banner (same as 3.png; 3 wins, it is the tenant's code), and
// 2687.png is Mandvi Mercantile again (1570 wins, it is the master-list id).
// 26897.png is THE JHALOD URBAN CO-OP BANK, which is not in master data at
// all; ruled 24 Aug 2026 to CREATE it, so this script does.
//
// THIS SCRIPT WRITES DEMO DATA ON PURPOSE, like its two siblings, and is
// scoped to LOCAL docker only: the shared RDS dataset is never rewritten by a
// script (CLAUDE.md, "SCHEMA ONLY, the shared data is never touched"). It
// writes rows directly rather than through the ops door because it runs as a
// bulk load under an explicit ruling, the same posture as the repoint script;
// the ops door (setBankBanner, setBankTemplateMaster) is the path for every
// upload after this one.
import process from 'node:process'
import console from 'node:console'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { URL } from 'node:url'
import { createRequire } from 'node:module'

// pdf-lib is services/fulfillment's own dependency; resolving it from there
// keeps this script version-locked to the renderer's PDF library.
const require = createRequire(new URL('../services/fulfillment/package.json', import.meta.url))
const { PDFDocument } = require('pdf-lib')

const DEFAULT_DIR = '/Users/rahulbhardwaj/Downloads/AND Srandee QR Frame'

// The frame's trim: 2260 x 4176 px at 600 dpi, in PDF points (72/inch).
const FRAME = { widthPt: 271.2, heightPt: 501.12 }

// Overlay calibration, measured off the frame's own pixels (24 Aug 2026):
// QR frame border x 375..1884, white interior down to y 2738, blue UPI tab
// y 2739..3094 (all from the top, in template pixels), SCAN & PAY band
// y 864..950, every printed element in #144a96. yFrac values are fractions
// of page height FROM THE BOTTOM (PDF coordinates), per the renderer's
// OverlayConfig contract.
const OVERLAY = {
  banner: { yFrac: 0.92, widthFrac: 0.86 },
  name: { yFrac: 0.832, size: 15, colorHex: '#144a96' },
  legal: { yFrac: 0.796, size: 8, colorHex: '#144a96' },
  qr: { yFrac: 0.395, sideFrac: 0.531 },
  vpa: { yFrac: 0.291, size: 14, colorHex: '#ffffff' },
}

// Files that are a second copy of a bank already covered by another code.
const ALIAS_SKIP = new Set(['19483', '2687'])

const JHALOD = { code: '26897', displayName: 'The Jhalod Urban Co-op Bank Ltd, Jhalod' }

function parseArgs(argv) {
  const out = { apply: false, dir: DEFAULT_DIR }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--dir') out.dir = argv[++i]
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
      'usage: node infra/apply-standee-frame.mjs [--dir D] --bucket B --prefix dev [--profile P] [--region R] [--apply]',
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

  const framePath = join(args.dir, 'New Size.png')
  const bankDir = join(args.dir, 'Bank')
  if (!existsSync(framePath) || !existsSync(bankDir)) {
    console.error(`REFUSING: ${args.dir} does not hold "New Size.png" and "Bank/".`)
    process.exitCode = 1
    return
  }

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
  console.log(`frame       : ${framePath}`)
  console.log(`mode        : ${args.apply ? 'APPLY' : 'DRY RUN'}\n`)

  // ---- 0. Preconditions ------------------------------------------------
  const tenants = await idb.$queryRawUnsafe(`SELECT id::text AS id, display_name FROM identity.tenant ORDER BY created_at LIMIT 1`)
  if (tenants.length === 0) {
    console.error('REFUSING: no tenant in identity.')
    process.exitCode = 1
    return
  }
  const tenant = tenants[0]

  const aggregators = await idb.$queryRawUnsafe(
    `SELECT id::text AS id, aggregator_code, display_name FROM identity.aggregator`,
  )
  const byCode = new Map(aggregators.map((r) => [r.aggregator_code, r]))
  if (!byCode.has('18')) {
    console.error('REFUSING: the numeric codes are not applied yet. Run infra/renumber-aggregator-codes.mjs --apply first.')
    process.exitCode = 1
    return
  }

  // ---- 1. Jhalod Urban (26897), ruled created 24 Aug 2026 ----------------
  if (!byCode.has(JHALOD.code)) {
    console.log(`aggregator  : creating ${JHALOD.code} ${JHALOD.displayName}`)
    if (args.apply) {
      const rows = await idb.$queryRawUnsafe(
        `INSERT INTO identity.aggregator (id, tenant_id, aggregator_code, display_name, status, is_default, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2, $3, 'ACTIVE', false, now())
         RETURNING id::text AS id`,
        tenant.id,
        JHALOD.code,
        JHALOD.displayName,
      )
      await tdb.$executeRawUnsafe(
        `INSERT INTO tms.aggregator_projection (id, tenant_id, aggregator_code, display_name, status, is_default, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'ACTIVE', false, now())
         ON CONFLICT (id) DO NOTHING`,
        rows[0].id,
        tenant.id,
        JHALOD.code,
        JHALOD.displayName,
      )
      byCode.set(JHALOD.code, { id: rows[0].id, aggregator_code: JHALOD.code, display_name: JHALOD.displayName })
    } else {
      // Dry run: count its banner in the plan below as APPLY would.
      byCode.set(JHALOD.code, { id: 'dry-run', aggregator_code: JHALOD.code, display_name: JHALOD.displayName })
    }
  } else {
    console.log(`aggregator  : ${JHALOD.code} already exists`)
  }

  // ---- 2. The shared frame, wrapped as a one-page PDF at its own trim ----
  // The renderer's master path embeds a PDF page; the ops door demands one
  // (template_not_pdf). Wrapping the PNG full-bleed at the measured trim is
  // the exact PDF the bank's designer would have exported.
  const framePng = readFileSync(framePath)
  const frameDoc = await PDFDocument.create()
  frameDoc.setCreationDate(new Date(0))
  frameDoc.setModificationDate(new Date(0))
  const img = await frameDoc.embedPng(framePng)
  const page = frameDoc.addPage([FRAME.widthPt, FRAME.heightPt])
  page.drawImage(img, { x: 0, y: 0, width: FRAME.widthPt, height: FRAME.heightPt })
  const framePdf = await frameDoc.save()
  console.log(`frame pdf   : ${framePdf.length} bytes at ${FRAME.widthPt} x ${FRAME.heightPt} pt`)

  // Both groups share the one frame (ruled 24 Aug 2026): the two merged
  // delivery PDFs stay equal-trim by construction. Keys match what the ops
  // door (setBankTemplateMaster) builds for the default row's '' code.
  let collateralRef = null
  let soundboxRef = null
  if (args.apply) {
    collateralRef = (await store.put('template/COLLATERAL/', framePdf, { contentType: 'application/pdf', filename: 'New Size.pdf' })).reference
    soundboxRef = (await store.put('template/SOUNDBOX/', framePdf, { contentType: 'application/pdf', filename: 'New Size.pdf' })).reference
    await fdb.$executeRawUnsafe(
      `INSERT INTO fulfillment.bank_composition_config
         (id, tenant_id, bank_code, branch_code, collateral_template_ref, soundbox_template_ref, branding_params, image_templates, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, '', '', $2, $3, '{}'::jsonb, $4::jsonb, now())
       ON CONFLICT (tenant_id, bank_code, branch_code)
       DO UPDATE SET collateral_template_ref = EXCLUDED.collateral_template_ref,
                     soundbox_template_ref = EXCLUDED.soundbox_template_ref,
                     image_templates = EXCLUDED.image_templates,
                     updated_at = now()`,
      tenant.id,
      collateralRef,
      soundboxRef,
      JSON.stringify({
        SOUNDBOX: { overlay: OVERLAY },
        STANDEE: { overlay: OVERLAY },
        STICKER: { overlay: OVERLAY },
      }),
    )
    console.log(`template    : stored for both groups on the ('','') default row, overlay calibration written`)
  } else {
    console.log(`template    : would store for both groups on the ('','') default row, plus overlay calibration`)
  }

  // ---- 3. The banners --------------------------------------------------
  const files = readdirSync(bankDir).filter((f) => f.endsWith('.png'))
  const withBanner = new Set()
  let stored = 0
  const orphans = []
  for (const f of files.sort((a, b) => Number.parseInt(a) - Number.parseInt(b))) {
    const code = f.replace(/\.png$/, '')
    if (ALIAS_SKIP.has(code)) continue
    const agg = byCode.get(code)
    if (agg === undefined) {
      orphans.push(code)
      continue
    }
    withBanner.add(code)
    if (args.apply) {
      const bytes = readFileSync(join(bankDir, f))
      const put = await store.put(`${code}:banner`, bytes, { contentType: 'image/png', filename: f })
      await fdb.$executeRawUnsafe(
        `INSERT INTO fulfillment.bank_composition_config
           (id, tenant_id, bank_code, branch_code, header_banner_ref, branding_params, image_templates, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2, '', $3, '{}'::jsonb, '{}'::jsonb, now())
         ON CONFLICT (tenant_id, bank_code, branch_code)
         DO UPDATE SET header_banner_ref = EXCLUDED.header_banner_ref, updated_at = now()`,
        tenant.id,
        code,
        put.reference,
      )
    }
    stored += 1
  }
  console.log(`banners     : ${stored} ${args.apply ? 'stored' : 'to store'} (${ALIAS_SKIP.size} aliases skipped)`)
  if (orphans.length > 0) console.log(`  banner files with no aggregator: ${orphans.join(', ')}`)
  const missing = aggregators.filter((a) => !withBanner.has(a.aggregator_code) && a.aggregator_code !== '')
  if (missing.length > 0) {
    console.log(`  aggregators with no banner (${missing.length}):`)
    for (const m of missing) console.log(`    ${m.aggregator_code}  ${m.display_name}`)
  }

  if (!args.apply) {
    console.log(`\nDRY RUN: nothing written. Re-run with --apply.`)
    await Promise.all([fdb.$disconnect(), tdb.$disconnect(), idb.$disconnect()])
    return
  }

  // ---- 4. Re-render every batch so the stored artifacts show the frame --
  // Same pattern as infra/repoint-demo-bank-codes.mjs: the render puts a NEW
  // version at the derived key, so each composed_artifact row must move to
  // the returned reference or it keeps serving the pre-frame bytes.
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
    if (wire === undefined) {
      console.log(`  ${b.btch_uuid}: no artifact rows to repoint, skipped`)
      continue
    }
    try {
      const prepared = await preRenderArtifacts(
        fdb,
        store,
        { btchId: wire, tenantId: b.tenant_id, programId: b.program_id, triggerReason: 'FRAME', unitCount: 0, asgnIds: [] },
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

  // ---- 5. Prove it -------------------------------------------------------
  let bad = 0
  for (const ref of [collateralRef, soundboxRef]) {
    if (ref !== null && (await store.getByReference(ref)) === null) {
      console.error(`  template ${ref} does not resolve`)
      bad += 1
    }
  }
  const bannerRows = await fdb.$queryRawUnsafe(
    `SELECT bank_code, header_banner_ref FROM fulfillment.bank_composition_config WHERE header_banner_ref IS NOT NULL`,
  )
  for (const r of bannerRows) {
    if ((await store.getByReference(r.header_banner_ref)) === null) {
      console.error(`  ${r.bank_code}: banner ${r.header_banner_ref} does not resolve`)
      bad += 1
    }
  }
  const live = await fdb.$queryRawUnsafe(
    `SELECT asset_reference FROM fulfillment.composed_artifact WHERE superseded_by IS NULL`,
  )
  let resolved = 0
  for (const r of live) if ((await store.getByReference(r.asset_reference)) !== null) resolved += 1

  console.log(`\n${bannerRows.length} banner refs, ${bad} unresolved problems`)
  console.log(`repointed ${repointed} artifact row(s), ${failed} batch failure(s)`)
  console.log(`${resolved}/${live.length} live artifact references resolve`)
  await Promise.all([fdb.$disconnect(), tdb.$disconnect(), idb.$disconnect()])
  if (bad > 0 || failed > 0 || resolved !== live.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(String(err.stack ?? err.message ?? err))
  process.exitCode = 1
})
