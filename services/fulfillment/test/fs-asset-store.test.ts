import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { FilesystemAssetStore } from '../src/storage/fs-asset-store.js'
import { InMemoryAssetStore } from '../src/storage/dev-asset-store.js'

// The filesystem AssetStore adapter. The point of this adapter is that a
// SECOND instance, standing in for a second PROCESS, can resolve a reference
// the first one minted. Every other test here is the port's contract, checked
// against the same expectations the in-memory adapter already satisfies.

const meta = { contentType: 'application/pdf', filename: 'collateral.pdf' }
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'andpay-asset-test-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('FilesystemAssetStore', () => {
  it('resolves a reference minted by a DIFFERENT instance, which is the whole point', async () => {
    // The writer, standing in for apps/consumer composing the PDF.
    const writer = new FilesystemAssetStore(root)
    const { reference } = await writer.put('artifact/btch_1/asgn_1', bytes('PDF-BYTES'), meta)

    // The reader, standing in for the ops edge in another process. It shares
    // nothing with `writer` except the directory.
    const reader = new FilesystemAssetStore(root)
    const got = await reader.getByReference(reference)

    expect(got).not.toBeNull()
    expect(text(got!.bytes)).toBe('PDF-BYTES')
    expect(got!.meta).toEqual(meta)
  })

  it('is the behaviour the in-memory adapter CANNOT provide', async () => {
    // Pinning the exact defect this adapter was written for: a second
    // in-memory instance resolves the same reference to null, which is the
    // 500 the collateral download was returning. If this ever passes, the
    // in-memory adapter has changed and this adapter's reason to exist has
    // moved.
    const writer = new InMemoryAssetStore()
    const { reference } = await writer.put('artifact/btch_1/asgn_1', bytes('PDF-BYTES'), meta)
    const otherProcess = new InMemoryAssetStore()
    expect(await otherProcess.getByReference(reference)).toBeNull()
  })

  it('keeps every version resolvable and makes the newest current', async () => {
    const store = new FilesystemAssetStore(root)
    const first = await store.put('k', bytes('one'), meta)
    const second = await store.put('k', bytes('two'), meta)

    expect(first.version).toBe('v1')
    expect(second.version).toBe('v2')
    expect(text((await store.getByReference(first.reference))!.bytes)).toBe('one')
    expect(text((await store.getByReference(second.reference))!.bytes)).toBe('two')
    expect(text((await store.getCurrent('k'))!.bytes)).toBe('two')
  })

  it('lists versions newest first, per the port contract', async () => {
    const store = new FilesystemAssetStore(root)
    await store.put('k', bytes('one'), meta)
    await store.put('k', bytes('two'), meta)
    expect((await store.listVersions('k')).map((v) => v.version)).toEqual(['v2', 'v1'])
  })

  it('answers null rather than throwing for anything it does not hold', async () => {
    const store = new FilesystemAssetStore(root)
    expect(await store.getCurrent('never-put')).toBeNull()
    expect(await store.listVersions('never-put')).toEqual([])
    expect(await store.getByReference('dev-asset:never-put:v1')).toBeNull()
    // Not this adapter's reference format at all.
    expect(await store.getByReference('s3://bucket/object?versionId=abc')).toBeNull()
  })

  it('handles a key containing a colon, which the reference format must not split on', async () => {
    const store = new FilesystemAssetStore(root)
    const key = 'artifact:with:colons/btch_1'
    const { reference } = await store.put(key, bytes('COLON'), meta)
    expect(text((await store.getByReference(reference))!.bytes)).toBe('COLON')
  })

  it('does not let a caller mutating its own buffer change what was stored', async () => {
    const store = new FilesystemAssetStore(root)
    const buf = bytes('ORIGINAL')
    const { reference } = await store.put('k', buf, meta)
    buf.fill(0)
    expect(text((await store.getByReference(reference))!.bytes)).toBe('ORIGINAL')
  })

  it('gives concurrent writers on one key distinct versions rather than losing one', async () => {
    const store = new FilesystemAssetStore(root)
    const results = await Promise.all([
      store.put('k', bytes('a'), meta),
      store.put('k', bytes('b'), meta),
      store.put('k', bytes('c'), meta),
    ])
    const versions = results.map((r) => r.version)
    expect(new Set(versions).size).toBe(3)
    // All three remain independently resolvable.
    const seen = await Promise.all(results.map(async (r) => text((await store.getByReference(r.reference))!.bytes)))
    expect(seen.sort()).toEqual(['a', 'b', 'c'])
  })
})
