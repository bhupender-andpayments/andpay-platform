// Hand-written types for postman/build-collection.mjs, matching the pattern
// infra/db-url.d.mts set: the implementation stays plain ESM so it runs as a
// bare `node postman/build-collection.mjs`, and this file is what lets the
// typed suite in test/ import it under NodeNext resolution.

/** What a `@Body()` type contributes to the generated request. */
export interface BodyShape {
  /** Field name to a type-derived placeholder. Never an invented domain value. */
  example: Record<string, unknown>
  /** Fields declared `name?:`, reported in the request description. */
  optional: string[]
  /** The interface name, or null for an inline object type. */
  typeName: string | null
}

/** The file fields a multipart route expects. */
export type UploadShape =
  | { kind: 'single'; field: string }
  | { kind: 'fields'; fields: string[] }

/** One parsed route, in source order within its controller. */
export interface ParsedRoute {
  verb: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Served path: controller base joined with the method path, leading slash. */
  path: string
  /** 1-based line of the member's first decorator. */
  line: number
  guards: string[]
  /** A guard is present, or the handler reads the Authorization header itself. */
  authRequired: boolean
  /** The handler reads the refresh cookie (the session routes). */
  cookieAuth: boolean
  needsIdempotency: boolean
  httpCode?: number
  upload?: UploadShape
  body?: BodyShape
  handler: string
}

/** A ParsedRoute plus where it came from, as returned by build(). */
export type FlatRoute = ParsedRoute & { edge: string; controller: string }

export declare function stripComments(src: string): string

export declare function parseController(absPath: string): {
  base: string | null
  routes: ParsedRoute[]
  decoratorCount?: number
}

export declare function build(): {
  /** A Postman Collection v2.1 document. */
  collection: {
    info: Record<string, string>
    auth: unknown
    variable: { key: string; value: string; type: string }[]
    item: { name: string; description?: string; item: unknown[] }[]
  }
  flat: FlatRoute[]
  /** Route decorators counted in the sources; must equal flat.length. */
  totalDecorators: number
}
