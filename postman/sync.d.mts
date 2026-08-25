// Hand-written types for postman/sync.mjs. See build-collection.d.mts for why
// these live beside the .mjs rather than in it.

/** One request, flattened out of Postman's arbitrarily deep folder tree. */
export interface FlatRequest {
  folder: string
  name: string
  method: string
  /** The raw url, variable prefix included: {{opsBase}}/ops/... */
  url: string
  /** `${method} ${url}` - the identity two collections are compared on. */
  key: string
  headers: string[]
  hasBody: boolean
}

export interface CollectionDiff {
  /** In the code, absent from the cloud. */
  missingInCloud: FlatRequest[]
  /** In the cloud only. A push DELETES these. */
  notInCode: FlatRequest[]
  /** Same route, different request. */
  changed: { key: string; deltas: string[] }[]
}

export declare const COLLECTION_UID: string
export declare const WORKSPACE_ID: string

export declare function flattenRequests(item: unknown[] | undefined, trail?: string[]): FlatRequest[]

export declare function diffCollections(
  localReqs: Pick<FlatRequest, 'key' | 'folder' | 'headers' | 'hasBody'>[],
  cloudReqs: Pick<FlatRequest, 'key' | 'folder' | 'headers' | 'hasBody'>[],
): CollectionDiff
