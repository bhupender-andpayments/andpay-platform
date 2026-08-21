import { describe, it, expect, beforeEach } from 'vitest'
import { S3AssetStore, parseAssetReference, s3ObjectKey, type S3Like } from '../src/storage/s3-asset-store.js'

// The S3 AssetStore adapter (E-5), tested against a FAKE S3 that enforces the
// two behaviours the real service guarantees and the adapter depends on:
// IfNoneMatch rejects an overwrite with PreconditionFailed, and a missing key
// raises NoSuchKey. No credentials, no network, so this runs in CI.
//
// The fake is deliberately strict rather than convenient. A permissive stub
// would let the read-modify-write race the conditional write exists to prevent
// pass silently, which is the one bug in this file that would cost real data.

interface StoredObject {
  body: Uint8Array
  contentType?: string
  metadata?: Record<string, string>
}

class FakeS3 implements S3Like {
  readonly objects = new Map<string, StoredObject>()
  /** Fires once, just before the Nth put commits, to simulate a racing writer. */
  onBeforePut?: (key: string) => void

  async send(command: unknown): Promise<unknown> {
    const c = command as { __type: string; input: Record<string, unknown> }
    const input = c.input
    if (c.__type === 'Put') {
      const key = input.Key as string
      this.onBeforePut?.(key)
      if (input.IfNoneMatch === '*' && this.objects.has(key)) {
        throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        })
      }
      this.objects.set(key, {
        body: input.Body as Uint8Array,
        contentType: input.ContentType as string | undefined,
        metadata: input.Metadata as Record<string, string> | undefined,
      })
      return {}
    }
    if (c.__type === 'Get') {
      const found = this.objects.get(input.Key as string)
      if (found === undefined) {
        throw Object.assign(new Error('The specified key does not exist.'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        })
      }
      return {
        Body: { transformToByteArray: async () => found.body },
        ContentType: found.contentType,
        Metadata: found.metadata,
      }
    }
    if (c.__type === 'Head') {
      const found = this.objects.get(input.Key as string)
      if (found === undefined) {
        throw Object.assign(new Error('Not Found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } })
      }
      return { ContentType: found.contentType, Metadata: found.metadata, ContentLength: found.body.length }
    }
    if (c.__type === 'List') {
      const prefix = (input.Prefix as string) ?? ''
      const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
      return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false }
    }
    throw new Error(`unexpected command ${c.__type}`)
  }
}

const commands = {
  PutObjectCommand: class {
    __type = 'Put'
    constructor(public input: Record<string, unknown>) {}
  },
  GetObjectCommand: class {
    __type = 'Get'
    constructor(public input: Record<string, unknown>) {}
  },
  ListObjectsV2Command: class {
    __type = 'List'
    constructor(public input: Record<string, unknown>) {}
  },
  HeadObjectCommand: class {
    __type = 'Head'
    constructor(public input: Record<string, unknown>) {}
  },
}

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)
const meta = { contentType: 'application/postscript', filename: 'ADC Bank qr code design_Final.ai' }

let s3: FakeS3
let store: S3AssetStore

beforeEach(() => {
  s3 = new FakeS3()
  store = new S3AssetStore({ bucket: 'mtms-dev-dispatch-module', prefix: 'dev', client: s3, commands })
})

describe('object layout', () => {
  it('writes under <prefix>/assets/<key>/<version>, keeping the key legible', async () => {
    await store.put('ADC-BANK', bytes('artwork'), meta)
    expect([...s3.objects.keys()]).toEqual(['dev/assets/ADC-BANK/v1'])
  })

  it('separates two environments sharing one bucket', async () => {
    // The collision this prefix exists to prevent: on 20 Aug an ADC-BANK logo
    // uploaded against local docker and one uploaded against the shared RDS
    // became v1 and v2 of a single key in the filesystem adapter's one root.
    const other = new S3AssetStore({ bucket: 'mtms-dev-dispatch-module', prefix: 'uat', client: s3, commands })
    await store.put('ADC-BANK', bytes('dev artwork'), meta)
    await other.put('ADC-BANK', bytes('uat artwork'), meta)

    expect((await store.getCurrent('ADC-BANK'))!.version).toBe('v1')
    expect((await other.getCurrent('ADC-BANK'))!.version).toBe('v1')
    expect(text((await store.getCurrent('ADC-BANK'))!.bytes)).toBe('dev artwork')
    expect(text((await other.getCurrent('ADC-BANK'))!.bytes)).toBe('uat artwork')
  })

  it('encodes a key segment so it cannot escape its own prefix', async () => {
    await store.put('ADC-BANK:derivative', bytes('png'), meta)
    expect([...s3.objects.keys()][0]).toBe('dev/assets/ADC-BANK%3Aderivative/v1')
  })

  it('keeps a slash-bearing artifact key as real prefixes, unlike the hashing fs adapter', async () => {
    await store.put('artifact/btch_01/asgn_02/STICKER_IMG', bytes('img'), meta)
    expect([...s3.objects.keys()][0]).toBe('dev/assets/artifact/btch_01/asgn_02/STICKER_IMG/v1')
  })

  it('refuses to construct without a bucket or an environment prefix', () => {
    expect(() => new S3AssetStore({ bucket: '', prefix: 'dev', client: s3, commands })).toThrow(/bucket/)
    expect(() => new S3AssetStore({ bucket: 'b', prefix: '', client: s3, commands })).toThrow(/prefix/)
  })
})

describe('versioning', () => {
  it('supersedes the current version while the old reference keeps resolving', async () => {
    const first = await store.put('ADC-BANK', bytes('v1 artwork'), meta)
    const second = await store.put('ADC-BANK', bytes('v2 artwork'), meta)
    expect(second.version).toBe('v2')

    expect(text((await store.getCurrent('ADC-BANK'))!.bytes)).toBe('v2 artwork')
    // The port's promise: history is retained and nothing is ever deleted.
    expect(text((await store.getByReference(first.reference))!.bytes)).toBe('v1 artwork')
  })

  it('lists newest first and orders numerically, so v10 outranks v9', async () => {
    for (let i = 0; i < 11; i += 1) await store.put('K', bytes(`b${i}`), meta)
    const versions = (await store.listVersions('K')).map((v) => v.version)
    expect(versions.slice(0, 3)).toEqual(['v11', 'v10', 'v9'])
    // Lexicographic ordering would put v9 first; the port says newest first.
    expect(versions[0]).toBe('v11')
  })

  it('claims a version with a conditional write, so a racing writer never overwrites', async () => {
    await store.put('K', bytes('first'), meta)
    // A competitor commits v2 in the window between this put's LIST and its
    // write. The conditional write must reject, and the retry must land v3.
    let fired = false
    s3.onBeforePut = (key) => {
      if (fired || !key.endsWith('/v2')) return
      fired = true
      s3.objects.set('dev/assets/K/v2', { body: bytes('competitor') })
    }
    const result = await store.put('K', bytes('mine'), meta)

    expect(result.version).toBe('v3')
    expect(text((await store.getByReference('s3-asset:K:v2'))!.bytes)).toBe('competitor')
    expect(text((await store.getByReference(result.reference))!.bytes)).toBe('mine')
  })
})

describe('reference compatibility, so nothing stored has to be rewritten', () => {
  it('resolves a legacy dev-asset: reference to the same object', async () => {
    // 453 references in this shape are already persisted across the local and
    // shared databases. The port promises a reference keeps resolving.
    await store.put('ADC-BANK', bytes('artwork'), meta)
    const viaLegacy = await store.getByReference('dev-asset:ADC-BANK:v1')
    expect(viaLegacy).not.toBeNull()
    expect(text(viaLegacy!.bytes)).toBe('artwork')
  })

  it('emits the new format on write but reports the same bytes either way', async () => {
    const put = await store.put('ADC-BANK', bytes('artwork'), meta)
    expect(put.reference).toBe('s3-asset:ADC-BANK:v1')
    const a = await store.getByReference('s3-asset:ADC-BANK:v1')
    const b = await store.getByReference('dev-asset:ADC-BANK:v1')
    expect(text(a!.bytes)).toBe(text(b!.bytes))
  })

  it('resolves a legacy reference whose key contains a colon or slash', async () => {
    await store.put('ADC-BANK:derivative', bytes('png'), meta)
    expect(await store.getByReference('dev-asset:ADC-BANK:derivative:v1')).not.toBeNull()
    await store.put('artifact/btch_01/STICKER_IMG', bytes('img'), meta)
    expect(await store.getByReference('dev-asset:artifact/btch_01/STICKER_IMG:v1')).not.toBeNull()
  })

  it('parses both formats and rejects anything else', () => {
    expect(parseAssetReference('s3-asset:K:v2')).toEqual({ key: 'K', version: 'v2' })
    expect(parseAssetReference('dev-asset:K:v2')).toEqual({ key: 'K', version: 'v2' })
    // The two fixture strings that leaked into a real database.
    expect(parseAssetReference('ref-logo-master')).toBeNull()
    expect(parseAssetReference('')).toBeNull()
  })
})

describe('reads', () => {
  it('round-trips the metadata, including a filename with spaces', async () => {
    const put = await store.put('ADC-BANK', bytes('artwork'), meta)
    const got = await store.getByReference(put.reference)
    expect(got!.meta).toEqual(meta)
  })

  it('answers null for an unknown key, version, or unparseable reference', async () => {
    expect(await store.getCurrent('NOPE')).toBeNull()
    await store.put('K', bytes('b'), meta)
    expect(await store.getByReference('s3-asset:K:v9')).toBeNull()
    expect(await store.getByReference('ref-logo-master')).toBeNull()
    expect(await store.listVersions('NOPE')).toEqual([])
  })

  it('surfaces a non-404 failure instead of reporting it as absent', async () => {
    // Reporting AccessDenied as "no such asset" would turn a broken credential
    // into a silent empty logo on every piece of collateral.
    const denied = new S3AssetStore({
      bucket: 'b',
      prefix: 'dev',
      client: {
        async send() {
          throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })
        },
      },
      commands,
    })
    await expect(denied.getByReference('s3-asset:K:v1')).rejects.toThrow(/Access Denied/)
  })

  it('ignores a stray object that is not a version under the key prefix', async () => {
    await store.put('K', bytes('b'), meta)
    s3.objects.set('dev/assets/K/notes.txt', { body: bytes('x') })
    expect((await store.listVersions('K')).map((v) => v.version)).toEqual(['v1'])
  })
})

describe('the exported layout function the migration shares', () => {
  it('agrees exactly with where the adapter writes', async () => {
    // The migration computes destinations with s3ObjectKey and the adapter
    // reads with its own private path builder. If these ever diverge the bytes
    // land somewhere no read looks, which is silent and total data loss.
    for (const key of ['ADC-BANK', 'ADC-BANK:derivative', 'artifact/btch_01/asgn_02/STICKER_IMG', 'a b/c#d']) {
      const fresh = new FakeS3()
      const s = new S3AssetStore({ bucket: 'b', prefix: 'dev', client: fresh, commands })
      const put = await s.put(key, bytes('x'), meta)
      expect([...fresh.objects.keys()]).toEqual([s3ObjectKey('dev', key, put.version)])
    }
  })

  it('trims stray slashes on the prefix, so "dev/" and "dev" are one location', () => {
    expect(s3ObjectKey('/dev/', 'K', 'v1')).toBe(s3ObjectKey('dev', 'K', 'v1'))
  })
})

describe('listVersions metadata, which the version-history UI prints', () => {
  it('returns the real filename and content type per version, not blanks', async () => {
    // Regression: the first cut returned empty meta because an S3 LIST carries
    // no user metadata, and the aggregator dialog promptly rendered "v2" with
    // no filename beside it. Caught against the live bucket, not in this file,
    // which is why the case is here now.
    await store.put('ADC-BANK', bytes('one'), { contentType: 'application/postscript', filename: 'first.ai' })
    await store.put('ADC-BANK', bytes('two'), { contentType: 'application/postscript', filename: 'second.ai' })
    const versions = await store.listVersions('ADC-BANK')
    expect(versions.map((v) => [v.version, v.meta.filename])).toEqual([
      ['v2', 'second.ai'],
      ['v1', 'first.ai'],
    ])
    expect(versions[0]!.meta.contentType).toBe('application/postscript')
  })

  it('keeps a version in the history even when its metadata cannot be read', async () => {
    await store.put('K', bytes('b'), meta)
    const flaky = new S3AssetStore({
      bucket: 'b',
      prefix: 'dev',
      client: {
        async send(command: unknown) {
          const c = command as { __type: string; input: Record<string, unknown> }
          if (c.__type === 'Head') throw new Error('transient')
          return s3.send(command)
        },
      },
      commands,
    })
    const versions = await flaky.listVersions('K')
    expect(versions.map((v) => v.version)).toEqual(['v1'])
    expect(versions[0]!.meta.filename).toBe('')
  })
})
