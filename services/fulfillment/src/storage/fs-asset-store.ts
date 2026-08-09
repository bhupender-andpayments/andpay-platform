// DEV adapter for the AssetStore port (asset-store.ts): filesystem-backed, no
// AWS, no database migration.
//
// WHY THIS EXISTS, and why InMemoryAssetStore was not enough. The in-memory
// adapter keeps its bytes in two per-INSTANCE Maps, so it only works when the
// writer and the reader are the SAME process. In the running system they are
// not: apps/consumer composes the collateral PDFs and stores their bytes,
// while the ops edge (and the vendor edge) SERVE those bytes from a different
// OS process. The composed_artifact row reached shared Postgres, the bytes did
// not, and every collateral download answered 500 while the database looked
// perfectly healthy. This adapter closes that gap by putting the bytes
// somewhere both processes can see.
//
// This is still a DEV adapter and it is NOT the S3 adapter E-5 needs. It has
// no durability guarantees beyond the local filesystem, no lifecycle policy,
// no encryption at rest, and no cross-host story. It exists so the pipeline is
// honest end to end on one machine, not to be shipped.
//
// LAYOUT. One directory per logical key, named by the SHA-256 of the key
// rather than the key itself: keys carry '/' and are unbounded in length, so
// neither a single path component nor a nested path is safe. Each version is
// two files, the bytes and a sidecar JSON:
//
//   <root>/<sha256(key)>/v1.bin
//   <root>/<sha256(key)>/v1.json   { key, version, meta }
//
// The key is recorded in the sidecar so a directory remains self-describing;
// nothing needs to reverse the hash.
//
// REFERENCE FORMAT is deliberately IDENTICAL to the in-memory adapter's,
// `dev-asset:<key>:<version>`, so references already persisted in
// composed_artifact.asset_reference by either adapter keep resolving. The port
// says a CALLER must never parse a reference; an adapter parsing its own
// format is exactly what the port intends by "opaque to callers". Parsing is
// anchored on the trailing `:v<digits>` so a key containing ':' stays
// unambiguous.
//
// CONCURRENCY. The version number is derived from what is already on disk, not
// from an instance counter, because an instance counter cannot be correct
// across processes (two processes would both mint v1 for different bytes and
// the second would silently overwrite the first's reference). put() claims its
// version with an EXCLUSIVE create and retries on collision, so two processes
// racing on the same key get two distinct versions rather than one lost write.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AssetStore, AssetMeta, AssetRecord, PutResult, StoredAsset } from './asset-store.js'

const REFERENCE_PATTERN = /^dev-asset:(.*):(v\d+)$/

// Bounded so a pathological race cannot spin forever. Ten is far beyond any
// real contention here: only the collateral composer writes assets.
const MAX_CLAIM_ATTEMPTS = 10

interface Sidecar {
  key: string
  version: string
  meta: AssetMeta
}

/**
 * The default root. Both the consumer and the edge resolve the same path on
 * one machine, so the demo works with no configuration. Point
 * ANDPAY_ASSET_DIR at a shared location to override it.
 */
export function defaultAssetDir(): string {
  return process.env.ANDPAY_ASSET_DIR ?? path.join(os.tmpdir(), 'andpay-asset-store')
}

function keyDir(root: string, key: string): string {
  return path.join(root, createHash('sha256').update(key, 'utf8').digest('hex'))
}

function versionNumber(version: string): number {
  return Number(version.slice(1))
}

export class FilesystemAssetStore implements AssetStore {
  private readonly root: string

  constructor(root: string = defaultAssetDir()) {
    this.root = root
  }

  /**
   * Every version already on disk for one key, ascending. Missing directory
   * means "never put", which is not an error.
   */
  private async versionsOnDisk(key: string): Promise<string[]> {
    const dir = keyDir(this.root, key)
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return entries
      .filter((e) => e.endsWith('.json'))
      .map((e) => e.slice(0, -'.json'.length))
      .filter((v) => /^v\d+$/.test(v))
      .sort((a, b) => versionNumber(a) - versionNumber(b))
  }

  async put(key: string, bytes: Uint8Array, meta: AssetMeta): Promise<PutResult> {
    const dir = keyDir(this.root, key)
    await fs.mkdir(dir, { recursive: true })

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const existing = await this.versionsOnDisk(key)
      const next = existing.length === 0 ? 1 : versionNumber(existing[existing.length - 1]!) + 1
      const version = `v${next}`
      const sidecar: Sidecar = { key, version, meta: { ...meta } }
      try {
        // 'wx' fails if the file already exists, which is how a concurrent
        // writer is detected. The sidecar is the claim, so it is written
        // FIRST: a reader only trusts a version whose sidecar exists.
        await fs.writeFile(path.join(dir, `${version}.json`), JSON.stringify(sidecar), { flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw err
      }
      // Copy via Buffer.from so a caller mutating its own buffer after put()
      // cannot change what was stored, matching the in-memory adapter.
      await fs.writeFile(path.join(dir, `${version}.bin`), Buffer.from(bytes))
      return { reference: `dev-asset:${key}:${version}`, version }
    }
    throw new Error(`could not claim an asset version for a key after ${MAX_CLAIM_ATTEMPTS} attempts`)
  }

  private async read(key: string, version: string): Promise<AssetRecord | null> {
    const dir = keyDir(this.root, key)
    try {
      const [rawSidecar, bytes] = await Promise.all([
        fs.readFile(path.join(dir, `${version}.json`), 'utf8'),
        fs.readFile(path.join(dir, `${version}.bin`)),
      ])
      const sidecar = JSON.parse(rawSidecar) as Sidecar
      return {
        reference: `dev-asset:${key}:${version}`,
        version,
        meta: { ...sidecar.meta },
        bytes: new Uint8Array(bytes),
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // A claimed-but-not-yet-written version (the tiny window between the two
      // writes in put()) reads as absent rather than as a failure, which is
      // the same answer a caller gets for a reference that never existed.
      if (code === 'ENOENT') return null
      throw err
    }
  }

  async getCurrent(key: string): Promise<AssetRecord | null> {
    const versions = await this.versionsOnDisk(key)
    if (versions.length === 0) return null
    return await this.read(key, versions[versions.length - 1]!)
  }

  async getByReference(reference: string): Promise<AssetRecord | null> {
    const match = REFERENCE_PATTERN.exec(reference)
    if (match === null) return null
    return await this.read(match[1]!, match[2]!)
  }

  async listVersions(key: string): Promise<StoredAsset[]> {
    const versions = await this.versionsOnDisk(key)
    const out: StoredAsset[] = []
    // Newest first, per the port's documented contract.
    for (const version of versions.slice().reverse()) {
      const dir = keyDir(this.root, key)
      try {
        const sidecar = JSON.parse(await fs.readFile(path.join(dir, `${version}.json`), 'utf8')) as Sidecar
        out.push({ reference: `dev-asset:${key}:${version}`, version, meta: { ...sidecar.meta } })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw err
      }
    }
    return out
  }
}
