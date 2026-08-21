// Binary-asset storage PORT (BRD Annexure D.2: bank/branch logo assets, one
// current .ai master + rasterized derivatives per logical key, with version
// history retained). No implementation lives here -- this is the interface a
// backend adapter satisfies. The DEV adapter (in-memory, see dev-asset-store.ts)
// and a future AWS S3 adapter both implement AssetStore without changing
// consumers.
//
// Design notes for AWS-S3-implementability:
// - `key` is the caller's logical identity for "the current asset" (e.g. a
//   bank code or bank+branch code). It is NOT a storage path; an S3 adapter
//   is free to derive its own object-key layout from it.
// - `reference` is an OPAQUE, stable identifier for one exact version. A
//   caller must never parse it, construct it, or assume a format. The dev
//   adapter's references happen to be strings; an S3 adapter's references
//   could equally be `s3://bucket/key?versionId=...` or an opaque UUID -- the
//   port makes no promise either way. References must never carry secrets
//   (no credentials, no presigned-URL query strings) since references are
//   logged and persisted in application data (composed_artifact.asset_reference
//   today uses a bare string in the same shape).
// - `version` is a caller-visible, opaque-but-orderable token identifying one
//   put() call's result for a given key. It is exposed separately from
//   `reference` so a caller can show "version 3 of the HDFC logo" without
//   needing to parse the reference.
// - Putting a new asset for the same `key` supersedes the current version;
//   the previous version's `reference` keeps resolving via getByReference
//   (history retained, never deleted by this port).
// - No method returns or logs raw bytes as part of an error or log line;
//   callers are responsible for not logging the `bytes` field themselves.

/** Metadata describing one stored asset version. Extend additively only. */
export interface AssetMeta {
  /** MIME type, e.g. "application/postscript" for .ai, "image/png" for a raster derivative. */
  contentType: string
  /** Original filename as uploaded/supplied by the caller (e.g. "hdfc-logo.ai"). */
  filename: string
  /**
   * ISO 8601 instant this version was stored, filled by adapters on READ
   * paths from their backend's own clock (S3 LastModified, a file's mtime).
   * Optional additively: callers never supply it on put(), and a version
   * stored before an adapter recorded it simply lacks it.
   */
  lastModified?: string
}

/** One stored asset version: opaque reference + the version token + its metadata. */
export interface StoredAsset {
  reference: string
  version: string
  meta: AssetMeta
}

/** The result of a successful put(): the new version's reference and version token. */
export interface PutResult {
  reference: string
  version: string
}

/** A stored asset's bytes plus its metadata and identity, as returned by a read. */
export interface AssetRecord {
  reference: string
  version: string
  meta: AssetMeta
  bytes: Uint8Array
}

/**
 * Binary-asset storage port. A logical `key` has at most one CURRENT version
 * at a time; every version ever put() for that key remains retrievable by its
 * own `reference` (version history retained, nothing is ever deleted by this
 * interface).
 */
export interface AssetStore {
  /**
   * Store a new version of the asset identified by `key`. Becomes the
   * current version for that key; any prior current version is superseded
   * but remains retrievable via its own reference (history retained).
   */
  put(key: string, bytes: Uint8Array, meta: AssetMeta): Promise<PutResult>

  /**
   * The current version's bytes + meta + identity for `key`, or null if the
   * key has never been put() or has no current version.
   */
  getCurrent(key: string): Promise<AssetRecord | null>

  /**
   * The exact versioned asset (bytes + meta) for an opaque `reference`
   * previously returned by put(), or null if the reference is unknown.
   */
  getByReference(reference: string): Promise<AssetRecord | null>

  /**
   * All versions ever put() for `key`, newest first, without their bytes
   * (for history/listing UIs). Empty array if the key has never been put().
   */
  listVersions(key: string): Promise<StoredAsset[]>
}
