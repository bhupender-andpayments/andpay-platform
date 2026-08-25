// Prove an AWS credential can do what the S3 AssetStore adapter (go-live
// blocker E-5) will need, before any adapter exists.
//
//   node infra/s3-preflight.mjs --profile andpay-dev-rb mtms-dev-dispatch-module
//   pnpm s3:preflight -- --profile andpay-dev-rb mtms-dev-dispatch-module
//
// "ARE MY CREDENTIALS WORKING" IS THREE QUESTIONS, and the first can pass while
// the other two fail, which is why they are checked and reported separately:
//   1. Do they authenticate at all?            sts get-caller-identity
//   2. Is the bucket in an allowed region?     s3api get-bucket-location
//   3. Do they carry the actions we need?      a put/get/list/delete round trip
//
// REGION IS A RULE, NOT A PREFERENCE. S6 (RBI data localisation) makes storage
// India-only: ap-south-1 primary, ap-south-2 DR. A bucket anywhere else FAILS
// here rather than warning, because the remedy is a different bucket and not a
// configuration tweak.
//
// IT SHELLS OUT TO THE AWS CLI ON PURPOSE. The repo has no AWS SDK dependency
// yet, and adding one belongs to the adapter (E-5), not to a script whose whole
// job is to answer a question you have before you write the adapter. The CLI and
// the JS SDK resolve credentials through the same chain (environment first, then
// the named profile in ~/.aws), so what passes here is what the adapter will
// see. The one thing this cannot prove is SDK-specific behaviour, which is a
// fair trade for staying dependency-free.
//
// NO CREDENTIAL VALUE IS EVER PRINTED OR LOGGED (S4). The caller-identity ARN
// is printed because it is the answer to "which principal am I", and it is an
// identifier rather than a secret.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import console from 'node:console'

const execFileAsync = promisify(execFile)

const INDIA_REGIONS = ['ap-south-1', 'ap-south-2']

// get-bucket-location answers null (JSON) or an empty string for us-east-1, a
// documented API wart rather than a missing value.
const US_EAST_1_SENTINELS = new Set(['', 'null', 'None'])

function parseArgs(argv) {
  const buckets = []
  let profile
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') {
      profile = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length)
      continue
    }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`)
    buckets.push(arg)
  }
  return { profile, buckets }
}

async function aws(args, profile) {
  const full = profile === undefined ? args : [...args, '--profile', profile]
  try {
    const { stdout } = await execFileAsync('aws', full, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return { ok: true, out: stdout.trim() }
  } catch (err) {
    // The CLI puts its diagnostics on stderr and exits non-zero. The AWS error
    // code is the useful part, so it is lifted out of the prose.
    const text = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim()
    const code = /\(([A-Za-z0-9]+)\)\s+when calling/.exec(text)?.[1]
    return { ok: false, code, out: text }
  }
}

const results = []
function record(check, pass, detail) {
  results.push({ check, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${check}${detail === undefined ? '' : `  ${detail}`}`)
}

async function main() {
  const { profile, buckets } = parseArgs(process.argv.slice(2))
  if (buckets.length === 0) {
    console.error(
      'usage: node infra/s3-preflight.mjs [--profile NAME] BUCKET [BUCKET...]\n' +
        'Give at least one bucket. Nothing is written outside a preflight/ prefix, and it is deleted again.',
    )
    process.exitCode = 2
    return
  }

  // 1. Does the credential authenticate at all?
  console.log(`\nIdentity${profile === undefined ? ' (default credential chain)' : ` (profile ${profile})`}`)
  const who = await aws(['sts', 'get-caller-identity', '--output', 'json'], profile)
  if (!who.ok) {
    record('sts:GetCallerIdentity', false, who.code ?? 'see below')
    console.error(`\n${who.out}\n`)
    if (who.code === 'InvalidClientTokenId') {
      console.error(
        'InvalidClientTokenId means AWS does not recognise the access key id.\n' +
          'An access key id is 20 characters beginning AKIA (or ASIA for a temporary\n' +
          'credential, which also needs aws_session_token). A console username and\n' +
          'password cannot be used here: they sign in to the web console only.',
      )
    }
    process.exitCode = 1
    return
  }
  const identity = JSON.parse(who.out)
  record('sts:GetCallerIdentity', true, identity.Arn)

  for (const bucket of buckets) {
    console.log(`\nBucket ${bucket}`)

    // 2. Residency. Checked before anything is written, so a wrong-region
    // bucket is never given data to hold.
    const loc = await aws(['s3api', 'get-bucket-location', '--bucket', bucket, '--output', 'text'], profile)
    if (!loc.ok) {
      record('s3:GetBucketLocation', false, loc.code ?? 'see below')
      console.error(`    ${loc.out.split('\n')[0]}`)
    } else {
      const region = US_EAST_1_SENTINELS.has(loc.out) ? 'us-east-1' : loc.out
      const indian = INDIA_REGIONS.includes(region)
      record(
        's3:GetBucketLocation',
        indian,
        indian ? region : `${region} VIOLATES S6 (India only: ${INDIA_REGIONS.join(', ')}). Use a different bucket.`,
      )
    }

    const head = await aws(['s3api', 'head-bucket', '--bucket', bucket], profile)
    record('s3:HeadBucket (exists and reachable)', head.ok, head.ok ? undefined : (head.code ?? 'see below'))
    if (!head.ok) {
      console.error(`    ${head.out.split('\n')[0]}`)
      continue
    }

    // 3. The actions the adapter needs. The probe object is namespaced and
    // removed again; a leftover would be indistinguishable from real content.
    const key = `preflight/andpay-preflight-${process.pid}-${Date.now()}.txt`
    const payload = `andpay s3 preflight ${new Date().toISOString()}\n`

    // s3api --body takes a PATH, not stdin, so the probe body is a temp file.
    const tmp = join(tmpdir(), `andpay-preflight-${process.pid}.txt`)
    writeFileSync(tmp, payload)
    const put = await aws(
      ['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', tmp, '--content-type', 'text/plain'],
      profile,
    )
    unlinkSync(tmp)
    record('s3:PutObject', put.ok, put.ok ? key : (put.code ?? 'see below'))
    if (!put.ok) console.error(`    ${put.out.split('\n')[0]}`)

    if (put.ok) {
      const back = join(tmpdir(), `andpay-preflight-back-${process.pid}.txt`)
      const get = await aws(['s3api', 'get-object', '--bucket', bucket, '--key', key, back], profile)
      const roundTripped = get.ok && existsSync(back) && readFileSync(back, 'utf8').startsWith('andpay s3 preflight')
      record('s3:GetObject (bytes round-trip)', roundTripped, get.ok ? undefined : (get.code ?? 'see below'))
      if (existsSync(back)) unlinkSync(back)
      if (!get.ok) console.error(`    ${get.out.split('\n')[0]}`)

      const list = await aws(
        ['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', 'preflight/', '--max-items', '1', '--output', 'json'],
        profile,
      )
      record('s3:ListBucket', list.ok, list.ok ? undefined : (list.code ?? 'see below'))

      // Cleanup. The ONLY reason the preflight needs delete at all: the
      // AssetStore port never deletes ("version history retained, nothing is
      // ever deleted by this interface"), so the eventual service policy can
      // omit s3:DeleteObject entirely and leave expiry to a bucket lifecycle
      // rule. Worth knowing when the scoped IAM is written.
      const del = await aws(['s3api', 'delete-object', '--bucket', bucket, '--key', key], profile)
      record('s3:DeleteObject (probe cleanup only)', del.ok, del.ok ? undefined : (del.code ?? 'see below'))
      if (!del.ok) console.error(`    left behind: s3://${bucket}/${key}`)
    }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`)
  if (failed.length > 0) {
    console.log('failed: ' + failed.map((r) => r.check).join(', '))
    process.exitCode = 1
    return
  }

  // The set of actions just proven IS the policy, so it is printed rather than
  // guessed at when the service IAM is requested. DeleteObject is deliberately
  // absent: see the cleanup note above.
  console.log(
    '\nThe adapter needs only these, per bucket (no delete, the store is append-only):\n' +
      JSON.stringify(
        {
          Version: '2012-10-17',
          Statement: [
            { Effect: 'Allow', Action: ['s3:ListBucket', 's3:GetBucketLocation'], Resource: buckets.map((b) => `arn:aws:s3:::${b}`) },
            { Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: buckets.map((b) => `arn:aws:s3:::${b}/*`) },
          ],
        },
        null,
        2,
      ),
  )
}

main().catch((err) => {
  console.error(String(err.message ?? err))
  process.exitCode = 1
})
