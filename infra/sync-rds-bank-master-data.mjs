// Copy the bank-master MASTER DATA from local docker onto the shared developer
// RDS: the tenant's reference code, its aggregators (ids and codes verbatim),
// the bank composition config, and the TMS aggregator projection.
//
//   source infra/rds-env.sh
//   node infra/sync-rds-bank-master-data.mjs            # DRY RUN
//   node infra/sync-rds-bank-master-data.mjs --apply
//
// WHY THIS EXISTS, and why it is not `rds:sync`. `infra/rds-sync.sh` is SCHEMA
// ONLY and must stay that way (CLAUDE.md). This is the separate, explicitly
// destructive data decision that rule reserves, narrowed to master data: it
// REPLACES the shared instance's aggregators and bank config and leaves its
// merchants, assignments, batches and artifacts untouched.
//
// WHAT IT FIXES. The shared instance still carried the pre-renumber import:
// 94 aggregators on name-derived slug codes (ADC-BANK, THE-JAMNAGAR-MAHILA-...),
// bank config pointing at `dev-asset:<SLUG>:v1` in the dev in-memory store
// rather than S3, no header banners, and an empty aggregator projection. Local
// has since renumbered onto the banks' real numeric ids, merged GSCB onto '3',
// moved every asset key onto the immutable aggregator id, and loaded the
// standee frame and 87 banners. Because the S3 bucket is SHARED, carrying
// local's aggregator ids across is enough for the artwork to resolve there:
// nothing needs re-uploading.
//
// THE TENANT ID IS NOT COPIED. Local's tenant uuid and the shared instance's
// differ, and the tenant is what merchants, programs, enrollments and
// assignments hang from. Rewriting it would reach far outside master data, so
// every row copied here is RE-PARENTED onto the shared instance's own tenant.
// Aggregator ids match local exactly; the tenant id deliberately does not.
//
// WHAT IT DOES NOT FIX. The shared instance's dispatch data references bank
// codes 3, 9 and 17. Only '3' exists in local's master data, so its rows begin
// resolving while the 9 and 17 rows stay orphaned exactly as they already are.
// Those are dispatch records, not master data, and healing them is the full
// dataset refresh this script deliberately is not.
//
// The local ORPHAN config rows are not copied. Local carries two rows under a
// tenant that no longer exists, including a second ('','') default row. That
// pair is what made two tenants collide on one map key before the bulk config
// reads were tenant-scoped; recreating it on a shared instance would plant the
// same bug there. Only rows under local's live tenant travel.
import process from 'node:process'
import console from 'node:console'
import { URL } from 'node:url'

const LOCAL_IDENTITY = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity'
const LOCAL_TMS = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const LOCAL_FULFILLMENT = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'

// Prisma's interactive transactions default to a 5 SECOND timeout, which is
// generous locally and nowhere near enough here: the shared instance is in
// ap-south-1, and 95 single-row INSERTs over that link blew the limit and
// rolled the whole thing back. Both halves of the fix matter. The rows go in
// as ONE multi-row INSERT per table, so a table costs one round trip instead
// of a hundred, and the timeout is raised anyway so a slow link cannot
// half-apply a replace.
const TX_OPTIONS = { timeout: 120_000, maxWait: 20_000 }

/**
 * Build one multi-row INSERT with positional parameters.
 *
 * `columns` carry their cast (`id::uuid`), which is what lets a NULL land in a
 * uuid or jsonb column: an untyped NULL parameter is `text` to Postgres and
 * the insert fails on type, not on content. The cast is stripped for the
 * column list and kept for the placeholder.
 */
function multiRowInsert(table, columns, rows) {
  const names = columns.map((c) => `"${c.split('::')[0]}"`)
  const casts = columns.map((c) => c.split('::')[1])
  const params = []
  const tuples = rows.map((row) => {
    const placeholders = row.map((value, i) => {
      params.push(value)
      return `$${params.length}::${casts[i]}`
    })
    return `(${placeholders.join(', ')})`
  })
  return {
    sql: `INSERT INTO ${table} (${names.join(', ')}) VALUES ${tuples.join(', ')}`,
    params,
  }
}

function parseArgs(argv) {
  const out = { apply: false }
  for (const a of argv) {
    if (a === '--apply') out.apply = true
    else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

function isLoopback(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

// The inverse of infra/db.sh's guard. That one refuses to leave localhost; this
// one refuses to stay on it, because a "sync to the shared instance" that
// silently rewrote local docker would destroy the source of truth it is
// copying FROM. Both conditions are checked, host and TLS, for the same reason
// db.sh checks both: a port-forward to shared infrastructure presents as
// localhost.
function assertSharedTarget(url, name) {
  if (url === undefined || url === '') {
    console.error(`REFUSING: ${name} is not set. Run: source infra/rds-env.sh`)
    return false
  }
  const u = new URL(url)
  if (isLoopback(u.hostname)) {
    console.error(`REFUSING: ${name} points at ${u.hostname}, which is local docker, not the shared instance.`)
    return false
  }
  const sslmode = u.searchParams.get('sslmode')
  if (sslmode === null || sslmode.toLowerCase() === 'disable') {
    console.error(`REFUSING: ${name} does not request TLS; that is not the shared instance's url shape.`)
    return false
  }
  return true
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const targets = {
    IDENTITY_DATABASE_URL: process.env.IDENTITY_DATABASE_URL,
    TMS_DATABASE_URL: process.env.TMS_DATABASE_URL,
    FULFILLMENT_DATABASE_URL: process.env.FULFILLMENT_DATABASE_URL,
  }
  for (const [name, url] of Object.entries(targets)) {
    if (!assertSharedTarget(url, name)) {
      process.exitCode = 1
      return
    }
  }

  const { PrismaClient: IdentityClient } = await import('../services/identity/generated/client/index.js')
  const { PrismaClient: TmsClient } = await import('../services/tms/generated/client/index.js')
  const { PrismaClient: FulfillmentClient } = await import('../services/fulfillment/generated/client/index.js')

  const srcI = new IdentityClient({ datasourceUrl: LOCAL_IDENTITY })
  const srcT = new TmsClient({ datasourceUrl: LOCAL_TMS })
  const srcF = new FulfillmentClient({ datasourceUrl: LOCAL_FULFILLMENT })
  const dstI = new IdentityClient({ datasourceUrl: targets.IDENTITY_DATABASE_URL })
  const dstT = new TmsClient({ datasourceUrl: targets.TMS_DATABASE_URL })
  const dstF = new FulfillmentClient({ datasourceUrl: targets.FULFILLMENT_DATABASE_URL })

  try {
    console.log(`source : LOCAL docker (andpay)`)
    console.log(`target : ${new URL(targets.IDENTITY_DATABASE_URL).hostname}`)
    console.log(`mode   : ${args.apply ? 'APPLY' : 'DRY RUN'}\n`)

    const srcTenants = await srcI.$queryRawUnsafe(
      `SELECT id::text AS id, bank_reference_code, display_name FROM tenant ORDER BY id`,
    )
    const dstTenants = await dstI.$queryRawUnsafe(
      `SELECT id::text AS id, bank_reference_code, display_name FROM tenant ORDER BY id`,
    )
    if (srcTenants.length !== 1 || dstTenants.length !== 1) {
      console.error(
        `REFUSING: this script assumes exactly one tenant on each side; found ${srcTenants.length} local and ${dstTenants.length} remote.`,
      )
      process.exitCode = 1
      return
    }
    const src = srcTenants[0]
    const dst = dstTenants[0]

    const aggregators = await srcI.$queryRawUnsafe(
      `SELECT id::text AS id, aggregator_code, display_name, status, is_default, code_locked_at,
              address1, address2, address3, city, district, country, pin, mobile, email,
              created_at, updated_at
       FROM aggregator WHERE tenant_id = '${src.id}'::uuid ORDER BY aggregator_code`,
    )
    const configs = await srcF.$queryRawUnsafe(
      `SELECT id::text AS id, bank_code, branch_code, logo_master_ref, logo_derivative_ref,
              branding_params, image_templates, soundbox_template_ref, collateral_template_ref,
              header_banner_ref, created_at, updated_at
       FROM bank_composition_config WHERE tenant_id = '${src.id}'::uuid ORDER BY bank_code, branch_code`,
    )
    const orphanConfigs = await srcF.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM bank_composition_config WHERE tenant_id <> '${src.id}'::uuid`,
    )

    const dstAgg = await dstI.$queryRawUnsafe(`SELECT count(*)::int AS n FROM aggregator`)
    const dstCfg = await dstF.$queryRawUnsafe(`SELECT count(*)::int AS n FROM bank_composition_config`)
    const dstProj = await dstT.$queryRawUnsafe(`SELECT count(*)::int AS n FROM aggregator_projection`)

    console.log(`tenant  local  ${src.id}  code '${src.bank_reference_code}'  ${src.display_name}`)
    console.log(`tenant  shared ${dst.id}  code '${dst.bank_reference_code}'  ${dst.display_name}`)
    console.log(`        the shared tenant KEEPS its id; only its reference code is set to '${src.bank_reference_code}'\n`)
    console.log(`aggregators       : ${dstAgg[0].n} on the shared instance -> ${aggregators.length} from local`)
    console.log(`bank config rows  : ${dstCfg[0].n} on the shared instance -> ${configs.length} from local`)
    console.log(`aggregator_projection: ${dstProj[0].n} on the shared instance -> ${aggregators.length} from local`)
    console.log(`skipped locally    : ${orphanConfigs[0].n} config row(s) under a tenant that no longer exists\n`)

    const withBanner = configs.filter((c) => c.header_banner_ref !== null).length
    const withLogo = configs.filter((c) => c.logo_master_ref !== null).length
    console.log(`of the ${configs.length} config rows: ${withLogo} carry a logo, ${withBanner} carry a header banner`)
    const nonS3 = configs.filter(
      (c) => c.logo_master_ref !== null && !c.logo_master_ref.startsWith('s3-asset:'),
    )
    if (nonS3.length > 0) {
      console.log(`  NOTE ${nonS3.length} row(s) carry a non-S3 logo reference and will copy as-is:`)
      for (const r of nonS3) console.log(`    bank '${r.bank_code}' -> ${r.logo_master_ref}`)
    }
    console.log('')

    if (!args.apply) {
      console.log('DRY RUN. Nothing was written.')
      console.log('This REPLACES the shared instance\'s aggregators, bank config and aggregator projection.')
      console.log('It does NOT touch its merchants, assignments, batches or artifacts.')
      console.log('Re-run with --apply to perform it.')
      return
    }

    // identity: the tenant's reference code, then the aggregator set.
    await dstI.$transaction(async (tx) => {
      // `tenant` carries created_at only, no updated_at, so there is nothing
      // to touch besides the code itself.
      await tx.$executeRaw`UPDATE tenant SET bank_reference_code = ${src.bank_reference_code} WHERE id = ${dst.id}::uuid`
      await tx.$executeRaw`DELETE FROM aggregator WHERE tenant_id = ${dst.id}::uuid`
      const { sql, params } = multiRowInsert(
        'aggregator',
        ['id::uuid', 'tenant_id::uuid', 'aggregator_code::text', 'display_name::text', 'status::text',
         'is_default::boolean', 'code_locked_at::timestamptz', 'address1::text', 'address2::text',
         'address3::text', 'city::text', 'district::text', 'country::text', 'pin::text', 'mobile::text',
         'email::text', 'created_at::timestamptz', 'updated_at::timestamptz'],
        aggregators.map((a) => [
          a.id, dst.id, a.aggregator_code, a.display_name, a.status, a.is_default, a.code_locked_at,
          a.address1, a.address2, a.address3, a.city, a.district, a.country, a.pin, a.mobile, a.email,
          a.created_at, a.updated_at,
        ]),
      )
      await tx.$executeRawUnsafe(sql, ...params)
    }, TX_OPTIONS)
    console.log(`identity   : tenant code set to '${src.bank_reference_code}', ${aggregators.length} aggregators written`)

    // fulfillment: the bank composition config.
    await dstF.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM bank_composition_config WHERE tenant_id = ${dst.id}::uuid`
      const { sql, params } = multiRowInsert(
        'bank_composition_config',
        ['id::uuid', 'tenant_id::uuid', 'bank_code::text', 'branch_code::text', 'logo_master_ref::text',
         'logo_derivative_ref::text', 'branding_params::jsonb', 'image_templates::jsonb',
         'soundbox_template_ref::text', 'collateral_template_ref::text', 'header_banner_ref::text',
         'created_at::timestamptz', 'updated_at::timestamptz'],
        configs.map((c) => [
          c.id, dst.id, c.bank_code, c.branch_code, c.logo_master_ref, c.logo_derivative_ref,
          c.branding_params === null ? null : JSON.stringify(c.branding_params),
          c.image_templates === null ? null : JSON.stringify(c.image_templates),
          c.soundbox_template_ref, c.collateral_template_ref, c.header_banner_ref,
          c.created_at, c.updated_at,
        ]),
      )
      await tx.$executeRawUnsafe(sql, ...params)
    }, TX_OPTIONS)
    console.log(`fulfillment: ${configs.length} bank config rows written`)

    // tms: the projection. Written DIRECTLY, not through the rail: no relay or
    // consumer runs against the shared instance, so an enqueued fact would sit
    // in the outbox forever. This is the same admitted shortcut the sibling
    // demo-data scripts take, and the reason this file lives in infra/ rather
    // than in a service.
    await dstT.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM aggregator_projection WHERE tenant_id = ${dst.id}::uuid`
      const { sql, params } = multiRowInsert(
        'aggregator_projection',
        ['id::uuid', 'tenant_id::uuid', 'aggregator_code::text', 'display_name::text', 'status::text',
         'is_default::boolean', 'updated_at::timestamptz'],
        aggregators.map((a) => [
          a.id, dst.id, a.aggregator_code, a.display_name, a.status, a.is_default, a.updated_at,
        ]),
      )
      await tx.$executeRawUnsafe(sql, ...params)
    }, TX_OPTIONS)
    console.log(`tms        : ${aggregators.length} projection rows written`)
    console.log('\nDone. Merchants, assignments, batches and artifacts were not touched.')
  } finally {
    await Promise.all([
      srcI.$disconnect(), srcT.$disconnect(), srcF.$disconnect(),
      dstI.$disconnect(), dstT.$disconnect(), dstF.$disconnect(),
    ])
  }
}

await main()
