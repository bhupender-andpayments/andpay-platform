// THE ONE PLACE that decides which AssetStore adapter a process uses.
//
// WHY IT EXISTS, AND THE BUG IT CLOSES (21 Aug 2026). This rule used to be
// duplicated in apps/ops-edge/src/deps.ts and apps/vendor-edge/src/deps.ts,
// and the consumer never had it at all: apps/consumer/src/main.ts hardcoded
// `new FilesystemAssetStore()`. The consumer is the process that COMPOSES and
// STORES collateral, so with ANDPAY_S3_BUCKET set the platform silently split
// in two. The consumer wrote artifact bytes to a local temp directory and
// recorded `dev-asset:` references, while the S3-backed edges resolved those
// same references against the bucket, found nothing, and raised
// AssetResolutionError. Every batch composed after the S3 switch returned 500
// from GET /ops/batches/:btchId/collateral/:key, and the on-screen proof was
// blank, with nothing in the stored data to suggest which half was wrong.
//
// A writer and a reader disagreeing about where bytes live cannot be caught by
// either side's tests, so the remedy is structural: one exported resolver, and
// no `new FilesystemAssetStore()` anywhere outside this file and the tests. A
// fourth process added later inherits the rule instead of re-deriving it.
//
// THE ADAPTER CHOICE. ANDPAY_S3_BUCKET set means the S3 adapter (go-live
// blocker E-5); unset means the filesystem adapter, so local docker and CI
// behave exactly as before and no test needs credentials.
//
// The environment prefix is REQUIRED whenever the bucket is: one bucket holds
// more than one environment's assets, the logical key is a bank code that says
// nothing about which dataset wrote it, and two environments sharing a prefix
// interleave their version histories. That already happened once with the
// filesystem adapter's single temp-directory root, so this fails the process
// start closed rather than silently colliding.
//
// Credentials are never read here. The SDK's default chain (environment, then
// the shared profile) resolves them, which is what lets a local access key and
// a deployed instance role work without a code change (S4).
import type { AssetStore } from './asset-store.js'
import { FilesystemAssetStore } from './fs-asset-store.js'
import { createS3AssetStore } from './s3-asset-store.js'

export async function resolveAssetStoreFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<AssetStore> {
  const bucket = env.ANDPAY_S3_BUCKET
  if (bucket === undefined || bucket.trim() === '') return new FilesystemAssetStore()
  const prefix = env.ANDPAY_S3_PREFIX
  if (prefix === undefined || prefix.trim() === '') {
    throw new Error(
      'ANDPAY_S3_BUCKET is set but ANDPAY_S3_PREFIX is not. The prefix namespaces one environment inside the bucket; without it two environments overwrite each other version history.',
    )
  }
  return createS3AssetStore({
    bucket: bucket.trim(),
    prefix: prefix.trim(),
    // India only (S6). Defaulted rather than required so a local run needs one
    // variable, not three.
    region: env.AWS_REGION ?? 'ap-south-1',
  })
}
