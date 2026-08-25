// DEV adapter for the AssetStore port (asset-store.ts): in-memory only, no
// AWS, no database migration.
//
// Tradeoff, documented per the brief: in-memory is the simplest adapter and
// the friendliest for unit tests (no filesystem cleanup, no gitignored dev
// directory to manage), but it does NOT survive a process restart -- every
// put() asset is lost when the process exits. That is acceptable for a dev
// adapter: it exists only to let application code (T5) be built and tested
// against the AssetStore port before the real AWS S3 adapter lands. It must
// never be used to hold data that needs to outlive a process.
//
// Injectable by design: callers depend on the AssetStore interface, and a
// caller constructs (or is handed) one InMemoryAssetStore instance to inject
// wherever asset storage is needed. Swapping in a future S3AssetStore is a
// one-line change at the injection site, not a code change here.

import type { AssetStore, AssetMeta, AssetRecord, PutResult, StoredAsset } from './asset-store.js'

interface StoredVersion {
  reference: string
  version: string
  meta: AssetMeta
  bytes: Uint8Array
}

export class InMemoryAssetStore implements AssetStore {
  // key -> all versions ever put, oldest first. The current version is
  // always the last entry. Nothing is ever removed from this array (history
  // retained).
  private readonly versionsByKey = new Map<string, StoredVersion[]>()
  // reference -> the version record it identifies, for O(1) getByReference
  // regardless of which key (or how many versions) it belongs to.
  private readonly byReference = new Map<string, StoredVersion>()
  private counter = 0

  async put(key: string, bytes: Uint8Array, meta: AssetMeta): Promise<PutResult> {
    this.counter += 1
    // Opaque to callers; only structured for readability in test failures
    // and dev debugging. No secret material, no bytes, ever included.
    const version = `v${this.counter}`
    const reference = `dev-asset:${key}:${version}`
    const record: StoredVersion = {
      reference,
      version,
      // The adapter's own clock, per the port: put() callers never supply it.
      meta: { ...meta, lastModified: new Date().toISOString() },
      // Copy so a caller mutating its own buffer after put() cannot corrupt
      // the stored version.
      bytes: bytes.slice(),
    }
    const existing = this.versionsByKey.get(key)
    if (existing) {
      existing.push(record)
    } else {
      this.versionsByKey.set(key, [record])
    }
    this.byReference.set(reference, record)
    return { reference, version }
  }

  async getCurrent(key: string): Promise<AssetRecord | null> {
    const versions = this.versionsByKey.get(key)
    if (!versions || versions.length === 0) return null
    const latest = versions[versions.length - 1]
    if (!latest) return null
    return toRecord(latest)
  }

  async getByReference(reference: string): Promise<AssetRecord | null> {
    const record = this.byReference.get(reference)
    if (!record) return null
    return toRecord(record)
  }

  async listVersions(key: string): Promise<StoredAsset[]> {
    const versions = this.versionsByKey.get(key)
    if (!versions || versions.length === 0) return []
    // Newest first, per the port's documented contract.
    return versions
      .slice()
      .reverse()
      .map((v) => ({ reference: v.reference, version: v.version, meta: { ...v.meta } }))
  }
}

function toRecord(v: StoredVersion): AssetRecord {
  return {
    reference: v.reference,
    version: v.version,
    meta: { ...v.meta },
    // Copy out so a caller mutating the returned buffer cannot corrupt the
    // stored version.
    bytes: v.bytes.slice(),
  }
}
