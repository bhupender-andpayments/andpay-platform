// One-time DATA repair: give every aggregator the NUMERIC code its bank
// actually sends, replacing the name-derived slug the 93-bank import invented.
//
//   node infra/renumber-aggregator-codes.mjs --bucket B --prefix dev --profile P          # DRY RUN
//   node infra/renumber-aggregator-codes.mjs --bucket B --prefix dev --profile P --apply
//
// WHY IT IS NEEDED. aggregator_code is documented in the portal as "the code
// this bank appears as in the tenant's request files". The 93-bank import had
// only a logo list to work from, so it derived codes from names
// ('ADC-BANK', 'GODHRA-CITY-CO-OP-BANK'). The bank's own numbering is numeric:
// the approved standee proof prints '3 - 16' and '3 - 13' bottom right, and
// analytics.dispatch_row still carries bank_code '3' from the original demo
// file. So the slugs were wrong against the field's own definition, and every
// real request file would have missed on them.
//
// THE SOURCE OF TRUTH is the bank's own Active Aggregator Details Master List
// (14 May 2026), whose `id` column is the code. That workbook is not in this
// repo (it is bank data, not source), so the mapping it produced is embedded
// below literally: an auditable table beats a run that cannot be reproduced.
// Each pair was name-matched with IDF-weighted token scoring and then read by
// hand; the six entries marked MANUAL were resolved by hand because scoring
// could not separate them.
//
// WHAT IT DOES NOT DO. Three aggregators (Santrampur Urban, Lakhwada Nagrik,
// Lunawada Peoples) appear in neither the master list nor the standee-frame
// banner folder, so no numeric code exists anywhere to give them; they keep
// their slug and are named in the report rather than guessed at. The GSCB
// default aggregator and the ingest stub are handled by the dedicated merge
// step (see GSCB_MERGE below), ruled 24 Aug 2026.
//
// THIS SCRIPT WRITES DEMO DATA ON PURPOSE, like its sibling
// infra/repoint-demo-bank-codes.mjs, and is scoped to LOCAL docker only. The
// shared RDS dataset is never rewritten by a script (CLAUDE.md, "SCHEMA ONLY,
// the shared data is never touched").
//
// THE ASSET KEY IS THE CODE, so a rename alone would orphan the artwork. The
// logo master keys on the bare code and the derivative on '<code>:derivative'
// (services/fulfillment/src/ops.ts, setBankLogoPair), so after a rename
// getCurrent('18') finds nothing and the Master Data thumbnail goes blank even
// though the stored reference still resolves. Every version of both keys is
// therefore REPLAYED under the new key, in order, so v1..vN keep their
// numbering, and the config row is repointed at the new key's newest version.
// The old objects are left in place: nothing deletes from the asset store, and
// references already persisted in composed_artifact must keep resolving.
// One honest cost: a replayed version's lastModified is the clock of this run,
// so the portal's "replaced N ago" line resets to now.
//
// FIVE PLACES HOLD A CODE and all five move together, or the platform splits:
//   identity.aggregator.aggregator_code          the master record
//   tms.aggregator_projection.aggregator_code    the read side of the fact
//   fulfillment.bank_composition_config.bank_code  the logo/branding lookup
//   tms.assignment.bank_reference_code           what a dispatch resolved as
//   fulfillment.pending_pool_entry.bank_reference_code   ditto, pre-batch
// analytics.dispatch_row.bank_code is deliberately NOT rewritten: it is a
// report of what a file said at the time, not a pointer to master data.
import process from 'node:process'
import console from 'node:console'
import { URL } from 'node:url'

// Slug code -> numeric code, with the master-list name it was matched to.
const MAPPING = [
  ['ADC-BANK', '18'], // THE AHMEDABAD DISTRICT CO OP BANK LTD  (MANUAL: two master-list rows share this name, 18 and 2492; 18 is the older registration)
  ['RAJKOT-DISTRICT-CENTRAL-CO-OP-BANK', '1522'], // SHRI RAJKOT DISTRICT CO-OPERATIVE BANK LTD.  (MANUAL)
  ['AMRELI-DISTRICT-CENTRAL-CO-OP-BANK', '1523'], // AMRELI JILLA MADHYASTHA SAHAKARI BANK LTD.
  ['BANASKANTHA-DISTRICT-CENTRAL-CO-OP-BANK', '1524'], // THE BANASKANTHA DISTRICT CENTRAL CO-OP. BANK LTD.
  ['BARODA-DISTRICT-CENTRAL-CO-OP-BANK', '1525'], // THE BARODA CENTRAL CO-OPERATIVE BANK LTD.
  ['THE-SAURASHTRA-CO-OP-BANK-LTD', '1526'], // THE SAURASHTRA CO-OP BANK LTD.
  ['SHREE-BHAVNAGAR-NAGRIK-CO-OP-BANK', '1527'], // SHREE BHAVNAGAR NAGRIK SAHAKARI BANK LTD
  ['SHREE-DHARTI-CO-OP-BANK-LTD', '1528'], // SHREE DHARTI CO-OP BANK LTD
  ['BHARUCH-DISTRICT-CENTRAL-CO-OP-BANK', '1529'], // THE BHARUCH DISTRICT CENTRAL CO-OPERATIVE BANK LTD.
  ['BHAVNAGAR-DISTRICT-CENTRAL-CO-OP-BANK', '1530'], // THE BHAVNAGAR DISTRICT CO-OP BANK LTD
  ['THE-KHAMBHAT-NAGRIK-BANK', '1531'], // THE KHAMBHAT NAGRIK SAHKARI BANK LTD
  ['JAMNAGAR-DISTRICT-CENTRAL-CO-OP-BANK', '1532'], // THE JAMNAGAR DISTRICT CO OPERATIVE BANK LTD.
  ['SHREE-CHHANI-NAGRIK-SAHAKARI-BANK-LTD', '1554'], // SHRI CHHANI NAGRIK SAHAKARI BANK LTD  (MANUAL)
  ['MANINAGAR-CO-OP-BANK-LTD', '1555'], // MANINAGAR CO.OP. BANK LTD.
  ['JUNAGADH-DISTRICT-CENTRAL-CO-OP-BANK', '1556'], // THE JUNAGADH JILLA SAHAKARI BANK LTD.
  ['KHEDA-DISTRICT-CENTRAL-CO-OP-BANK', '1557'], // THE KHEDA DISTRICT CENTRAL CO OPERATIVE BANK LTD.
  ['VADNAGAR-NAGARIK-SAHKARI-BANK-LTD', '1558'], // VADNAGAR NAGARIK SAHKARI BANK LTD
  ['KACHCHH-DISTRICT-CENTRAL-CO-OP-BANK', '1559'], // THE KACHCHH DISTRICT CENTRAL CO OP BANK LTD.
  ['KODINAR-NAGRIK-CO-OP-BANK', '1560'], // THE KODINAR TALUKA CO OPERATIVE BANKING UNION LTD.  (MANUAL: only Kodinar bank in the list, but the name differs materially)
  ['GANDHIDHAM-MERCANTILE-CO-OP-BANK', '1561'], // THE GANDHIDHAM MERCANTILE CO-OP BANK LTD
  ['MEHSANA-DISTRICT-CENTRAL-CO-OP-BANK', '1562'], // THE MEHSANA DISTRICT CENTRAL CO OPERATIVE BANK LTD.
  ['KAPADVANJ-PEOPLES-CO-OP-BANK', '1563'], // THE KAPADWANJ PEOPLES CO-OP BANK LTD
  ['SURAT-DISTRICT-CENTRAL-CO-OP-BANK', '1564'], // THE SURAT DISTRICT CO OPERATIVE BANK LTD.
  ['SHREE-CO-OP-BANK-LTD', '1565'], // SHREE CO OP BANK LTD
  ['SHIHORI-NAGRIK-SAHKARI-BANK-LTD', '1566'], // SHIHORI NAGRIK SAHKARI BANK LTD
  ['SABARKANTHA-DISTRICT-CENTRAL-CO-OP-BANK', '1567'], // THE SABARKANTHA DISTRICT CENTRAL CO OPERATIVE BANK LTD.
  ['PANCHMAHAL-DISTRICT-CENTRAL-CO-OP-BANK', '1568'], // THE PANCHMAHAL DISTRICT CO OP BANK LTD
  ['SURENDRANAGAR-DISTRICT-CENTRAL-CO-OP-BAN', '1569'], // THE SURENDRANAGAR DISTRICT CO OPERATIVE BANK LTD.
  ['THE-MANDAVI-MERCANTILE-CO-OP-BANK', '1570'], // THE MANDAVI MERCANTILE CO OP BANK
  ['VALSAD-DISTRICT-CENTRAL-CO-OP-BANK', '1571'], // THE VALSAD DISTRICT CENTRAL CO-OPERATIVE BANK LTD.
  ['ODE-URBAN-CO-OP-BANK', '2695'], // THE ODE URBAN CO OPERATIVE BANK LTD
  ['ASSOCIATE-CO-OPERATIVE-BANK-LTD', '2696'], // ASSOCIATE CO OPERATIVE BANK LTD
  ['RAJULA-NAGRIK-CO-OP-BANK', '2712'], // THE RAJULA NAGARIK SAHAKARI BANK LTD
  ['GODHRA-URBAN-CO-OP-BANK', '2801'], // THE GODHRA URBAN CO OP BANK LTD
  ['BHUJ-COMMERCIAL-CO-OP-BANK', '2923'], // THE BHUJ COMMERCIAL CO-OPERATIVE BANK LTD
  ['BALASINOR-NAGARIK-SAHAKARI-BANK-LTD', '2926'], // BALASINOR NAGARIK SAHAKARI BANK LTD
  ['THE-KHEDA-PEOPLES-CO-OPERATIVE-BANK-LTD', '2927'], // THE KHEDA PEOPLE S CO OP BANK LTD  (MANUAL)
  ['SARDARGANJ-MERCANTILE-CO-OP-BANK', '2946'], // SARDARGANJ MERCANTILE CO OP BANK LTD
  ['JAMBUSAR-PEOPLES-CO-OPERATIVE-BANK', '2961'], // THE JAMBUSAR PEOPLES CO OP BANK LTD
  ['VEJALPUR-NAGARIK-CO-OPERATIVE-BANK', '3025'], // THE VEJALPUR NAGRIK SAHAKARI BANK LTD
  ['THE-GANDHIDHAM-CO-OP-BANK', '3043'], // THE GANDHIDHAM CO OPERATIVE BANK LTD.
  ['MEGHRAJ-NAGARIK-SAHAKARI-BANK-LTD', '3053'], // THE MEGHRAJ NAGRIK SAHKARI BANK LTD
  ['UNAVA-NAGRIK-SAHAKARI-BANK', '3054'], // THE UNAVA NAGARIK SAHAKARI BANK LTD
  ['GHOGHAMBA-VIBHAG-NAGARIK-SAHAKARI-BANK', '3123'], // GHOGHAMBA VIBHAG NAGRIK SAHAKARI BANK LTD
  ['THE-KALOL-URBAN-CO-OPERATIVE-BANK', '3142'], // THE KALOL URBAN CO OP BANK LTD
  ['SIHOR-MERCANTILE-CO-OPERATIVE-BANK-BHAVN', '3143'], // SIHOR MERCANTILE CO OPERATIVE BANK LTD
  ['THE-LIMDI-URBAN-CO-OP-BANK', '3158'], // THE LIMDI URBAN CO OP BANK LTD
  ['THE-SARVODAYA-SAHAKARI-BANK-MODASA', '3214'], // THE SARVODAY SAHKARI BANK LTD (MODASA)
  ['LIMBASI-URBAN-CO-OP-BANK', '3228'], // THE LIMBASI URBAN CO OP BANK LTD
  ['VADALI-SAHKARI-BANK-LTD', '3259'], // THE VADALI NAGRIK SAHKARI BANK LTD
  ['SHREE-SAVLI-CO-OP-BANK', '3278'], // SHREE SAVLI NAGRIK SAHKARI BANK LTD
  ['KARNAVATI-CO-OP-BANK-LTD', '3336'], // THE KARNAVATI CO. OP. BANK LTD
  ['THE-UNA-PEOPLES-CO-OPERATIVE-BANK-LTD', '3396'], // THE UNA PEOPLES CO-OP BANK LTD
  ['PRAGATI-CO-OP-BANK-THARA', '3476'], // THE PRAGATI CO OPERATIVE BANK LTD. (THARA)
  ['BARODA-CITY-CO-OP-BANK', '3491'], // THE BARODA CITY CO-OPERATIVE BANK LTD
  ['THE-UNION-CO-OPERATIVE-BANK', '3687'], // THE UNION CO-OPERATIVE BANK LTD
  ['THE-BHABHAR-VIBHAG-NAGRIK-SAHAKARI-BANK-', '3695'], // THE BHABHAR VIBHAG NAGRIK SAHAKARI BANK LTD
  ['THE-MAHUDHA-NAGARIK-SAHKARI-BANK-LTD', '3965'], // THE MAHUDHA NAGRIK SAHAKARI BANK LIMITED
  ['NAGRIK-SAHKARI-BANK-LTD-BABARA', '4079'], // NAGRIK SAHAKARI BANK LTD BABRA
  ['THE-CHHAPI-NAGARIK-SAHAKARI-BANK-LTD', '4134'], // THE CHHAPI NAGRIK SAHKARI BANK LTD
  ['SHREE-VIRPUR-URBAN-SAHAKARI-BANK-LTD', '4225'], // SHREE VIRPUR URBAN SAHAKARI BANK LTD
  ['THE-UMRETH-URBAN-CO-OP-BANK-LTD', '4269'], // THE UMRETH URBAN CO-OPERATIVE BANK LTD
  ['THE-THASRA-PEOPLES-CO-OP-BANK-LTD', '4361'], // THE THASRA PEOPLES CO OP BANK LTD
  ['THE-MEHMADABAD-URBAN-PEOPLES-CO-OP-BANK-', '4511'], // THE MEHMADABAD URBAN PEOPLES CO OPERATIVE BANK LTD
  ['THE-ANAND-MERCANTILE-CO-OPERATIVE-BANK-L', '4520'], // THE ANAND MERCANTILE CO-OPERATIVE BANK LTD
  ['THE-IDAR-NAGRIK-SAHAKARI-BANK-LTD', '4540'], // THE IDAR NAGRIK SAHAKARI BANK LTD
  ['SHREE-BHARAT-CO-OPERATIVE-BANK-LTD', '4590'], // SHREE BHARAT CO OPERATIVE BANK LTD
  ['THE-JANATA-CO-OP-BANK-LTD-GODHRA', '4592'], // THE JANATA CO OP BANK LTD  (MANUAL)
  ['DHANERA-MERCANTILE-CO-OP-BANK', '4746'], // DHANERA MERCANTILE CO-OPERATIVE BANK LTD
  ['GODHRA-CITY-CO-OP-BANK', '4844'], // THE GODHRA CITY CO OP BANK LTD
  ['THE-JAMNAGAR-PEOPLES-CO-OP-BANK-LTD', '5980'], // THE JAMNAGAR PEOPLES COOP BANK LTD. 
  ['THE-PANCHSHEEL-MERCANTILE-BANK', '5989'], // THE PANCHSHEEL MERCANTILE COOP BANK LTD.
  ['VIJAPUR-NAGARIK-BANK', '6140'], // THE VIJAPUR NAGARIK SAHAKARI BANK LTD
  ['THE-MARKETYARD-COMMERCIAL-CO-OP-BANK-LTD', '6142'], // MARKETYARD COMMERCIAL CO OP BANK LTD
  ['THE-HARIJ-NAGARIK-BANK-LTD', '6252'], // THE HARIJ NAGRIK SAHKARI BANK LTD
  ['SHREE-SAVARKUNDLA-NAGRIK-SAHKARI-BANK-LT', '6260'], // SHREE SAVARKUNDLA NAGRIK SAHAKARI BANK LTD
  ['THE-LUNAWADA-NAGARIK-SAHAKARI-BANK-LTD', '6300'], // THE LUNAWADA NAGRIK SAHKARI BANK LTD
  ['THE-TALOD-NAGRIK-SAHKARI-BANK-LTD', '6396'], // THE TALOD NAGARIK SAHAKRI BANK LTD
  ['SARVODAYA-NAGARIK-SAHAKARI-BANK-LTD', '7499'], // SARVODAYA NAGARIK SAHAKARI BANK LTD
  ['SHREE-MORBI-NAGARIK-SAHAKARI-BANK-LTD', '8606'], // SHREE MORBI NAGARIK SAHAKARI BANK LTD
  ['JIVAN-COMMERCIAL-CO-OPERATIVE-BANK-LTD', '8723'], // JIVAN COMMERCIAL CO-OP BANK LTD.
  ['THE-FINANCIAL-CO-OPERATIVE-BANK', '9292'], // THE FINANCIAL CO-OP BANK LTD
  // The 8 below are not in the 14-May master list; their numeric codes come
  // from the product team's standee-frame folder (AND Srandee QR Frame/Bank),
  // whose banner files are named by code, and each name was read off the
  // banner artwork itself (24 Aug 2026).
  ['THE-VIRAMGHAM-MERCANTILE-CO-OPERATIVE-BA', '10653'], // THE VIRAMGAM MERCANTILE CO-OPERATIVE BANK LTD
  ['THE-JAMNAGAR-MAHILA-SAHAKARI-BANK-LTD', '11152'], // THE JAMNAGAR MAHILA SAHAKARI BANK LTD
  ['APANI-SAHAKARI-BANK-LTD', '12892'], // APANI SAHAKARI BANK LTD
  ['THE-SARANGPUR-CO-OP-BANK', '18190'], // THE SARANGPUR CO-OPERATIVE BANK LTD
  ['AKHAND-ANAND-CO-OP-BANK-LTD', '18750'], // AKHAND ANAND CO. OP. BANK LTD
  ['THE-VEPAR-UDHYOG-VIKAS-SAHAKARI-BANK-LTD', '20877'], // THE VEPAR UDHYOG VIKAS SAHAKARI BANK LTD, JHALOD
  ['RAJKOT-NAGRIK-SAHKARI-BANK', '21784'], // RAJKOT NAGARIK SAHAKARI BANK LTD
  ['THE-CHANSMA-COMMERCIAL-CO-OP-BANK', '22162'], // THE CHANASMA COMMERCIAL CO-OP BANK LTD
]

// THE GSCB MERGE (ruled 24 Aug 2026). The bank's own numeric code is 3: the
// standee folder's 3.png is GSC Bank's banner, the approved July card prints
// '3 - 16', and the original demo files carried bank_code 3. Today that code
// is held by a STUB aggregator ingest created (display_name '3',
// code_locked_at set) before the import, while the tenant's default
// aggregator holds 'GSCB'. The merge deletes the stub and moves the default
// aggregator AND identity.tenant.bank_reference_code to '3' together,
// preserving the spec invariant that the default's code IS the tenant's code.
// editAggregator refuses this on purpose at the edge; a data script under an
// explicit ruling is the one place it happens.
const GSCB_MERGE = { stubCode: '3', defaultCode: 'GSCB', to: '3' }

// LEFT ALONE: aggregators with no row in the master list AND no banner file,
// so no numeric code exists anywhere to give them. They keep their slug and
// are reported, not guessed at.
const LEFT_ALONE = new Set([])

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

/**
 * Replay every version of oldKey under newKey, in ascending version order, so
 * the new key's v1..vN line up with the old key's. Returns the newest new-key
 * reference, or null when the old key holds nothing.
 */
async function replayKey(store, oldKey, newKey, apply) {
  const versions = await store.listVersions(oldKey)
  if (versions.length === 0) return { copied: 0, reference: null }
  versions.sort((a, b) => Number(a.version.slice(1)) - Number(b.version.slice(1)))
  if (!apply) return { copied: versions.length, reference: `s3-asset:${newKey}:${versions[versions.length - 1].version}` }

  // An earlier interrupted run may have copied some of these already. put()
  // always claims the NEXT free version, so replaying into a key that already
  // holds versions would shift the numbering; skip what is already there.
  const existing = (await store.listVersions(newKey)).length
  let reference = null
  for (let i = 0; i < versions.length; i += 1) {
    if (i < existing) continue
    const rec = await store.getByReference(versions[i].reference)
    if (rec === null) throw new Error(`${oldKey} ${versions[i].version} does not resolve; refusing to lose a version`)
    const put = await store.put(newKey, rec.bytes, { contentType: rec.meta.contentType, filename: rec.meta.filename })
    if (put.version !== versions[i].version) {
      throw new Error(`${newKey} landed at ${put.version} but ${oldKey} had ${versions[i].version}; version history would not line up`)
    }
    reference = put.reference
  }
  if (reference === null) {
    const current = await store.getCurrent(newKey)
    reference = current === null ? null : current.reference
  }
  return { copied: versions.length, reference }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.bucket === undefined || args.prefix === undefined) {
    console.error('usage: node infra/renumber-aggregator-codes.mjs --bucket B --prefix dev [--profile P] [--region R] [--apply]')
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

  const { createS3AssetStore } = await import('../services/fulfillment/dist/index.js')
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

  const live = await idb.$queryRawUnsafe(
    `SELECT aggregator_code, display_name, is_default, code_locked_at FROM identity.aggregator ORDER BY aggregator_code`,
  )
  const byCode = new Map(live.map((r) => [r.aggregator_code, r]))
  const targets = new Map(MAPPING)

  // PREFLIGHT. Every finding here is a reason to stop, not a warning to skip
  // past: a half-renumbered dataset resolves some logos and silently drops
  // others, which is the exact failure this run exists to end.
  const problems = []
  for (const [from, to] of targets) {
    const row = byCode.get(from)
    if (row === undefined) {
      // Already renumbered by an earlier run is fine; anything else is not.
      if (!byCode.has(to)) problems.push(`${from}: no such aggregator, and ${to} does not exist either`)
      continue
    }
    if (row.code_locked_at !== null) problems.push(`${from}: code_locked_at is set; ingest has already matched on it`)
    const collision = byCode.get(to)
    if (collision !== undefined) problems.push(`${from} -> ${to}: ${to} is already held by "${collision.display_name}"`)
  }
  const numericTargets = [...targets.values()]
  if (new Set(numericTargets).size !== numericTargets.length) {
    problems.push('the mapping sends two slugs to one numeric code')
  }
  if (problems.length > 0) {
    console.error('REFUSING, preflight found:')
    for (const p of problems) console.error(`  ${p}`)
    process.exitCode = 1
    return
  }

  const mergeHandled = new Set([GSCB_MERGE.stubCode, GSCB_MERGE.defaultCode])
  const unmapped = live.filter(
    (r) => !targets.has(r.aggregator_code) && !LEFT_ALONE.has(r.aggregator_code) && !mergeHandled.has(r.aggregator_code),
  )
  console.log(
    `aggregators : ${live.length} total, ${targets.size} renumbered, ${unmapped.length} with no numeric code, GSCB merge ${byCode.has(GSCB_MERGE.defaultCode) ? 'pending' : 'already done'}\n`,
  )
  for (const [from, to] of targets) {
    if (!byCode.has(from)) {
      console.log(`  ${from} -> ${to}: already done`)
      continue
    }
    const master = await replayKey(store, from, to, args.apply)
    const derivative = await replayKey(store, `${from}:derivative`, `${to}:derivative`, args.apply)

    if (args.apply) {
      await idb.$executeRawUnsafe(
        `UPDATE identity.aggregator SET aggregator_code = $1, updated_at = now() WHERE aggregator_code = $2`,
        to,
        from,
      )
      await tdb.$executeRawUnsafe(
        `UPDATE tms.aggregator_projection SET aggregator_code = $1, updated_at = now() WHERE aggregator_code = $2`,
        to,
        from,
      )
      await tdb.$executeRawUnsafe(
        `UPDATE tms.assignment SET bank_reference_code = $1, updated_at = now() WHERE bank_reference_code = $2`,
        to,
        from,
      )
      await fdb.$executeRawUnsafe(
        `UPDATE fulfillment.pending_pool_entry SET bank_reference_code = $1, updated_at = now() WHERE bank_reference_code = $2`,
        to,
        from,
      )
      // bank_code and the two refs move in one statement: a row carrying the
      // new code with the old key's references is the split this run is here
      // to prevent.
      await fdb.$executeRawUnsafe(
        `UPDATE fulfillment.bank_composition_config
            SET bank_code = $1,
                logo_master_ref = COALESCE($2, logo_master_ref),
                logo_derivative_ref = COALESCE($3, logo_derivative_ref),
                updated_at = now()
          WHERE bank_code = $4`,
        to,
        master.reference,
        derivative.reference,
        from,
      )
    }
    console.log(`  ${from} -> ${to}: ${master.copied} master, ${derivative.copied} derivative version(s) replayed`)
  }

  // THE GSCB MERGE (see the constant's header). Idempotent: once the default
  // aggregator holds the numeric code, there is nothing left to do.
  const stub = byCode.get(GSCB_MERGE.stubCode)
  const dflt = byCode.get(GSCB_MERGE.defaultCode)
  if (dflt === undefined) {
    console.log(`\nGSCB merge : already done (no aggregator holds '${GSCB_MERGE.defaultCode}')`)
  } else if (stub !== undefined && stub.is_default) {
    console.error(`\nREFUSING the GSCB merge: '${GSCB_MERGE.stubCode}' is itself the default aggregator.`)
    process.exitCode = 1
    return
  } else {
    const gscbMaster = await replayKey(store, GSCB_MERGE.defaultCode, GSCB_MERGE.to, args.apply)
    const gscbDeriv = await replayKey(store, `${GSCB_MERGE.defaultCode}:derivative`, `${GSCB_MERGE.to}:derivative`, args.apply)
    if (args.apply) {
      // The stub goes first, freeing the unique (tenant_id, aggregator_code)
      // slot the default is about to take.
      if (stub !== undefined) {
        await tdb.$executeRawUnsafe(
          `DELETE FROM tms.aggregator_projection WHERE aggregator_code = $1 AND NOT is_default`,
          GSCB_MERGE.stubCode,
        )
        await idb.$executeRawUnsafe(
          `DELETE FROM identity.aggregator WHERE aggregator_code = $1 AND NOT is_default`,
          GSCB_MERGE.stubCode,
        )
      }
      await idb.$executeRawUnsafe(
        `UPDATE identity.aggregator SET aggregator_code = $1, updated_at = now() WHERE aggregator_code = $2`,
        GSCB_MERGE.to,
        GSCB_MERGE.defaultCode,
      )
      // The invariant: the default's code IS the tenant's bank reference
      // code, so the two move in the same run or not at all.
      await idb.$executeRawUnsafe(
        `UPDATE identity.tenant SET bank_reference_code = $1 WHERE bank_reference_code = $2`,
        GSCB_MERGE.to,
        GSCB_MERGE.defaultCode,
      )
      await tdb.$executeRawUnsafe(
        `UPDATE tms.aggregator_projection SET aggregator_code = $1, updated_at = now() WHERE aggregator_code = $2`,
        GSCB_MERGE.to,
        GSCB_MERGE.defaultCode,
      )
      await tdb.$executeRawUnsafe(
        `UPDATE tms.tenant_projection SET bank_reference_code = $1, updated_at = now() WHERE bank_reference_code = $2`,
        GSCB_MERGE.to,
        GSCB_MERGE.defaultCode,
      )
      await tdb.$executeRawUnsafe(
        `UPDATE tms.assignment SET bank_reference_code = $1, updated_at = now() WHERE bank_reference_code = $2`,
        GSCB_MERGE.to,
        GSCB_MERGE.defaultCode,
      )
      await fdb.$executeRawUnsafe(
        `UPDATE fulfillment.pending_pool_entry SET bank_reference_code = $1, updated_at = now() WHERE bank_reference_code = $2`,
        GSCB_MERGE.to,
        GSCB_MERGE.defaultCode,
      )
      await fdb.$executeRawUnsafe(
        `UPDATE fulfillment.bank_composition_config
            SET bank_code = $1,
                logo_master_ref = COALESCE($2, logo_master_ref),
                logo_derivative_ref = COALESCE($3, logo_derivative_ref),
                updated_at = now()
          WHERE bank_code = $4`,
        GSCB_MERGE.to,
        gscbMaster.reference,
        gscbDeriv.reference,
        GSCB_MERGE.defaultCode,
      )
    }
    console.log(
      `\nGSCB merge : stub '${GSCB_MERGE.stubCode}' ${stub === undefined ? 'absent' : 'deleted'}, default '${GSCB_MERGE.defaultCode}' -> '${GSCB_MERGE.to}' (tenant bank_reference_code moves with it); ${gscbMaster.copied} master, ${gscbDeriv.copied} derivative version(s) replayed`,
    )
  }

  console.log(`\nno numeric code anywhere, slug kept (${unmapped.length}):`)
  for (const r of unmapped) console.log(`  ${r.aggregator_code}  ${r.display_name}`)

  if (!args.apply) {
    console.log(`\nDRY RUN: nothing written. Re-run with --apply.`)
    return
  }

  // VERIFY. Not a formality: the whole point is that every renumbered
  // aggregator still resolves artwork under its NEW key.
  console.log(`\nverifying...`)
  let bad = 0
  for (const [, to] of targets) {
    const cfg = await fdb.$queryRawUnsafe(
      `SELECT logo_master_ref, logo_derivative_ref FROM fulfillment.bank_composition_config WHERE bank_code = $1 AND branch_code = '' LIMIT 1`,
      to,
    )
    if (cfg.length === 0) { console.error(`  ${to}: no config row`); bad += 1; continue }
    for (const ref of [cfg[0].logo_master_ref, cfg[0].logo_derivative_ref]) {
      if (ref === null) continue
      if ((await store.getByReference(ref)) === null) { console.error(`  ${to}: ${ref} does not resolve`); bad += 1 }
    }
    if ((await store.getCurrent(to)) === null) { console.error(`  ${to}: getCurrent finds no master (the thumbnail would be blank)`); bad += 1 }
  }
  const stale = await tdb.$queryRawUnsafe(
    `SELECT DISTINCT bank_reference_code AS c FROM tms.assignment WHERE bank_reference_code !~ '^[0-9]+$'`,
  )
  for (const s of stale) { console.error(`  tms.assignment still carries a non-numeric code: ${s.c}`); bad += 1 }
  console.log(bad === 0 ? `  all ${targets.size} renumbered aggregators resolve.` : `  ${bad} problem(s).`)
  if (bad > 0) process.exitCode = 1
}

await main()
