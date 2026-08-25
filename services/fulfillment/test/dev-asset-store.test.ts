import { describe, it, expect } from 'vitest'
import { InMemoryAssetStore } from '../src/storage/dev-asset-store.js'

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('InMemoryAssetStore (dev AssetStore adapter)', () => {
  it('round-trips identical bytes and meta via put then getByReference', async () => {
    const store = new InMemoryAssetStore()
    const bytes = bytesOf('%PDF-fake-ai-master-bytes')
    const { reference, version } = await store.put('bank:hdfc', bytes, {
      contentType: 'application/postscript',
      filename: 'hdfc-logo.ai',
    })

    const record = await store.getByReference(reference)
    expect(record).not.toBeNull()
    expect(record!.reference).toBe(reference)
    expect(record!.version).toBe(version)
    // lastModified is stamped by the adapter at put(), per the port's
    // read-path contract; the caller-supplied fields round-trip untouched.
    expect(record!.meta.contentType).toBe('application/postscript')
    expect(record!.meta.filename).toBe('hdfc-logo.ai')
    expect(record!.meta.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(record!.bytes).toEqual(bytes)
  })

  it('does not alias the caller buffer or the stored buffer (defensive copies)', async () => {
    const store = new InMemoryAssetStore()
    const bytes = bytesOf('original')
    const { reference } = await store.put('bank:hdfc', bytes, { contentType: 'image/png', filename: 'logo.png' })

    // Mutate the caller's buffer after put(): the stored version must be unaffected.
    bytes[0] = 0

    const record = await store.getByReference(reference)
    expect(record!.bytes).toEqual(bytesOf('original'))

    // Mutate the returned buffer: a second read must be unaffected.
    record!.bytes[0] = 0
    const record2 = await store.getByReference(reference)
    expect(record2!.bytes).toEqual(bytesOf('original'))
  })

  it('supersedes the current version on a second put for the same key, retaining the old version by reference', async () => {
    const store = new InMemoryAssetStore()
    const v1Bytes = bytesOf('logo-v1')
    const v2Bytes = bytesOf('logo-v2')

    const v1 = await store.put('bank:sbi', v1Bytes, { contentType: 'application/postscript', filename: 'sbi-v1.ai' })
    const v2 = await store.put('bank:sbi', v2Bytes, { contentType: 'application/postscript', filename: 'sbi-v2.ai' })

    expect(v2.version).not.toBe(v1.version)
    expect(v2.reference).not.toBe(v1.reference)

    const current = await store.getCurrent('bank:sbi')
    expect(current).not.toBeNull()
    expect(current!.reference).toBe(v2.reference)
    expect(current!.version).toBe(v2.version)
    expect(current!.bytes).toEqual(v2Bytes)

    // History retained: the superseded version still resolves via its own reference.
    const oldRecord = await store.getByReference(v1.reference)
    expect(oldRecord).not.toBeNull()
    expect(oldRecord!.version).toBe(v1.version)
    expect(oldRecord!.bytes).toEqual(v1Bytes)

    const history = await store.listVersions('bank:sbi')
    expect(history).toHaveLength(2)
    const [newest, oldest] = history
    if (!newest || !oldest) throw new Error('expected exactly two history entries')
    // Newest first.
    expect(newest.reference).toBe(v2.reference)
    expect(oldest.reference).toBe(v1.reference)
  })

  it('returns null from getCurrent for a key that was never put', async () => {
    const store = new InMemoryAssetStore()
    expect(await store.getCurrent('bank:unknown')).toBeNull()
  })

  it('returns null from getByReference for an unknown reference', async () => {
    const store = new InMemoryAssetStore()
    await store.put('bank:hdfc', bytesOf('x'), { contentType: 'image/png', filename: 'x.png' })
    expect(await store.getByReference('dev-asset:bank:hdfc:v999')).toBeNull()
  })

  it('returns an empty list from listVersions for a key that was never put', async () => {
    const store = new InMemoryAssetStore()
    expect(await store.listVersions('bank:unknown')).toEqual([])
  })
})
