// Hand-written types for infra/db-url.mjs. The implementation is plain ESM so
// bash, the gitignored demo harness, and the typed suites can share one copy;
// this file is what lets test/ import it under NodeNext resolution.
export type ContextUrlKey =
  | 'IDENTITY_DATABASE_URL'
  | 'TMS_DATABASE_URL'
  | 'FULFILLMENT_DATABASE_URL'
  | 'ORCHESTRATOR_DATABASE_URL'
  | 'AUTH_DATABASE_URL'
  | 'ANALYTICS_DATABASE_URL'

export declare const CONTEXTS: readonly string[]
export declare function parseEnvFile(text: string): Record<string, string>
export declare function encodeUserinfo(value: string): string
export declare function deriveUrls(env: Record<string, string | undefined>): Record<ContextUrlKey, string>
export declare function deriveAdminUrl(env: Record<string, string | undefined>): string
export declare function loadEnvFile(path?: string): Record<string, string>
