// A per-write-action request-dedup token (the built E6 inbox honors it,
// effectively-once). NOT a domain id, no prefix. Generated once per user action
// and reused across the client's internal refresh/step-up retries.
export function newIdempotencyKey(): string { return crypto.randomUUID() }
