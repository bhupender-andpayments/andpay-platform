// The AWS S3 adapter for the AssetStore port (go-live blocker E-5, section 2.1).
// This is the first adapter meant to outlive a process: InMemoryAssetStore loses
// its bytes on restart and FilesystemAssetStore cannot be seen from another
// host.
//
// OBJECT LAYOUT. One bucket, prefixed by environment first (Rahul, 21 Aug 2026):
//
//   <bucket>/<prefix>/assets/<key>/<version>
//   e.g.    mtms-dev-dispatch-module/dev/assets/ADC-BANK/v1
//
// The ENVIRONMENT PREFIX is load bearing, not decoration. The logical key is a
// bank code (or a code plus a suffix), which carries no notion of which dataset
// wrote it, so two environments sharing a bucket would interleave their version
// histories under one path. That already happened with the filesystem adapter,
// whose root is a single OS temp directory: on 20 Aug an ADC-BANK logo uploaded
// against the shared RDS and one uploaded against local docker landed as v1 and
// v2 of the same key.
//
// THE KEY IS USED RAW, NOT HASHED, unlike FilesystemAssetStore. That adapter
// hashes because a logical key contains '/' and is unbounded, and neither is
// safe as a single path component. In S3 a '/' is only a prefix separator and
// keys may be 1024 bytes, so the real key survives and the bucket stays
// legible in the console: `dev/assets/ADC-BANK/v1` says what it is. Keys are
// percent-encoded per segment anyway, so a key containing a character S3 treats
// specially cannot escape its own prefix.
//
// VERSION CLAIMING USES A CONDITIONAL WRITE. Deriving the next version from a
// LIST and then writing it is a read-modify-write race: two processes both see
// v1, both write v2, and one silently destroys the other's reference. S3
// supports `IfNoneMatch: '*'` (fails with PreconditionFailed when the object
// exists), which is exactly the semantics FilesystemAssetStore gets from an
// exclusive-create `wx` open, so the same claim-and-retry loop is correct here.
//
// TWO REFERENCE FORMATS ARE ACCEPTED ON READ, ONE IS EMITTED ON WRITE. New puts
// return `s3-asset:<key>:<version>`. Reads ALSO accept the dev adapters'
// `dev-asset:<key>:<version>`, because 453 such references are already
// persisted in bank_composition_config and composed_artifact across the local
// and shared databases, and the port promises a reference keeps resolving.
// Both map to the same object, so a migrated object answers to either name and
// no stored row has to be rewritten. The port tells CALLERS never to parse a
// reference; an adapter parsing its own (and its predecessor's) format is
// exactly what "opaque to callers" leaves room for.
//
// METADATA RIDES ON THE OBJECT. contentType is the object's Content-Type and
// filename is user metadata, so there is no sidecar to fall out of step with
// the bytes and no second request to read it.
import type { AssetStore, AssetMeta, AssetRecord, PutResult, StoredAsset } from './asset-store.js'

/** The subset of the S3 client this adapter uses, so tests can inject a fake. */
export interface S3Like {
  send(command: unknown): Promise<unknown>
}

export interface S3AssetStoreOptions {
  bucket: string
  /** Environment namespace, e.g. 'dev'. Slashes are trimmed. */
  prefix: string
  client: S3Like
  /**
   * Command constructors, injected so the adapter can be unit tested without a
   * network or credentials. Production passes the real @aws-sdk/client-s3 ones.
   */
  commands: {
    PutObjectCommand: new (input: Record<string, unknown>) => unknown
    GetObjectCommand: new (input: Record<string, unknown>) => unknown
    ListObjectsV2Command: new (input: Record<string, unknown>) => unknown
    HeadObjectCommand: new (input: Record<string, unknown>) => unknown
  }
}

const LEGACY_REFERENCE = /^dev-asset:(.*):(v\d+)$/
const REFERENCE = /^s3-asset:(.*):(v\d+)$/

// Same bound and same reason as FilesystemAssetStore: a pathological race must
// not spin forever, and ten is far beyond any real contention.
const MAX_CLAIM_ATTEMPTS = 10

function versionNumber(version: string): number {
  return Number(version.slice(1))
}

/** Percent-encode each segment so a key can never escape its own prefix. */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * The object key one version lives at. Exported because the one-time migration
 * (infra/s3-migrate-assets.mjs) has to write exactly where a read will look;
 * a second copy of this rule would drift and strand the bytes.
 */
export function s3ObjectKey(prefix: string, key: string, version: string): string {
  return `${prefix.replace(/^\/+|\/+$/g, '')}/assets/${encodeKey(key)}/${version}`
}

/** Parse either reference format. Returns null for anything else. */
export function parseAssetReference(reference: string): { key: string; version: string } | null {
  const match = REFERENCE.exec(reference) ?? LEGACY_REFERENCE.exec(reference)
  if (match === null) return null
  return { key: match[1]!, version: match[2]! }
}

async function collect(body: unknown): Promise<Uint8Array> {
  // The SDK's Body is a stream in Node and a Blob in the browser; only the
  // Node shape can occur here, but transformToByteArray is the documented
  // helper and is preferred when present.
  const stream = body as {
    transformToByteArray?: () => Promise<Uint8Array>
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>
  }
  if (typeof stream.transformToByteArray === 'function') return stream.transformToByteArray()
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
    total += chunk.length
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function isPreconditionFailed(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404
}

export class S3AssetStore implements AssetStore {
  private readonly bucket: string
  private readonly prefix: string
  private readonly client: S3Like
  private readonly commands: S3AssetStoreOptions['commands']

  constructor(options: S3AssetStoreOptions) {
    this.bucket = options.bucket
    this.prefix = options.prefix.replace(/^\/+|\/+$/g, '')
    this.client = options.client
    this.commands = options.commands
    if (this.bucket === '') throw new Error('S3AssetStore needs a bucket name.')
    if (this.prefix === '') throw new Error('S3AssetStore needs an environment prefix, e.g. "dev".')
  }

  /** `<prefix>/assets/<encoded key>/` - every version of one logical key. */
  private keyPrefix(key: string): string {
    return `${this.prefix}/assets/${encodeKey(key)}/`
  }

  private objectKey(key: string, version: string): string {
    return s3ObjectKey(this.prefix, key, version)
  }

  async put(key: string, bytes: Uint8Array, meta: AssetMeta): Promise<PutResult> {
    const { PutObjectCommand } = this.commands
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const existing = await this.listVersions(key)
      const next = existing.length === 0 ? 1 : versionNumber(existing[0]!.version) + 1
      const version = `v${next}`
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.objectKey(key, version),
            Body: bytes,
            ContentType: meta.contentType,
            Metadata: { filename: encodeURIComponent(meta.filename) },
            // Fail rather than overwrite if another writer claimed this version
            // first. Without it this is a read-modify-write race and the loser's
            // reference silently resolves to the winner's bytes.
            IfNoneMatch: '*',
          }),
        )
      } catch (err) {
        if (isPreconditionFailed(err)) continue
        throw err
      }
      return { reference: `s3-asset:${key}:${version}`, version }
    }
    throw new Error(`could not claim an asset version for a key after ${MAX_CLAIM_ATTEMPTS} attempts`)
  }

  async getCurrent(key: string): Promise<AssetRecord | null> {
    const versions = await this.listVersions(key)
    if (versions.length === 0) return null
    return this.read(key, versions[0]!.version)
  }

  async getByReference(reference: string): Promise<AssetRecord | null> {
    const parsed = parseAssetReference(reference)
    if (parsed === null) return null
    return this.read(parsed.key, parsed.version)
  }

  async listVersions(key: string): Promise<StoredAsset[]> {
    const { ListObjectsV2Command } = this.commands
    const prefix = this.keyPrefix(key)
    const names: string[] = []
    let token: string | undefined
    do {
      const page = (await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      )) as { Contents?: { Key?: string }[]; NextContinuationToken?: string; IsTruncated?: boolean }
      for (const item of page.Contents ?? []) {
        const name = item.Key?.slice(prefix.length)
        if (name === undefined || !/^v\d+$/.test(name)) continue
        names.push(name)
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined
    } while (token !== undefined)

    // Newest first, matching the port's stated order. Numeric, not
    // lexicographic: v10 must sort above v9.
    names.sort((a, b) => versionNumber(b) - versionNumber(a))

    // A LIST response carries no user metadata, so the filename and content
    // type need one HEAD each. That cost is deliberate: listVersions feeds the
    // version-history UI, which prints the filename beside each version, and
    // returning blanks there showed up immediately as "v2" with no name next to
    // it. Version counts per key are small (one per re-upload of a logo), and
    // the heads run concurrently, so this is one round trip in practice.
    const { HeadObjectCommand } = this.commands
    return Promise.all(
      names.map(async (version) => {
        let meta: AssetMeta = { contentType: '', filename: '' }
        try {
          const head = (await this.client.send(
            new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key, version) }),
          )) as { ContentType?: string; Metadata?: Record<string, string>; LastModified?: Date }
          const raw = head.Metadata?.filename
          meta = {
            contentType: head.ContentType ?? '',
            filename: raw === undefined ? '' : decodeURIComponent(raw),
            // S3's own write instant, per the port's read-path contract.
            ...(head.LastModified instanceof Date ? { lastModified: head.LastModified.toISOString() } : {}),
          }
        } catch {
          // A version that lists but will not HEAD still belongs in the
          // history; the caller gets the version token with empty metadata
          // rather than losing the entry altogether.
        }
        return { reference: `s3-asset:${key}:${version}`, version, meta }
      }),
    )
  }

  private async read(key: string, version: string): Promise<AssetRecord | null> {
    const { GetObjectCommand } = this.commands
    try {
      const res = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key, version) }),
      )) as { Body?: unknown; ContentType?: string; Metadata?: Record<string, string> }
      if (res.Body === undefined) return null
      const raw = res.Metadata?.filename
      return {
        reference: `s3-asset:${key}:${version}`,
        version,
        meta: {
          contentType: res.ContentType ?? 'application/octet-stream',
          filename: raw === undefined ? '' : decodeURIComponent(raw),
        },
        bytes: await collect(res.Body),
      }
    } catch (err) {
      // An absent object is a null answer, exactly as the port specifies; every
      // other failure (denied, throttled, network) must surface.
      if (isNotFound(err)) return null
      throw err
    }
  }
}

/**
 * Build the production adapter from the real SDK. Kept separate from the class
 * so the class itself stays free of any import the unit tests would drag in,
 * and so credential resolution is the SDK's default chain (environment, then
 * the shared profile) rather than anything this repo invents: S4 means no
 * credential is ever read from code or a config file here.
 */
export async function createS3AssetStore(options: { bucket: string; prefix: string; region: string }): Promise<AssetStore> {
  const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand } = await import('@aws-sdk/client-s3')
  // The injection type is deliberately loose (Record<string, unknown>) so a
  // test can supply a fake without importing the SDK. The SDK's own
  // constructors are narrower than that, and a TS interface has no implicit
  // index signature, so they need one cast at this single production seam. The
  // adapter is the only thing that builds these inputs and it always builds
  // valid ones; the alternative is dragging the SDK's types into every test.
  const commands = { PutObjectCommand, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand } as unknown as S3AssetStoreOptions['commands']
  return new S3AssetStore({
    bucket: options.bucket,
    prefix: options.prefix,
    client: new S3Client({ region: options.region }),
    commands,
  })
}
