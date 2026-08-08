/**
 * The outboxes this relay drains, and the infra role each one drains under.
 *
 * THE PLAN SAID "ALL FIVE CONTEXT OUTBOXES". THE DATABASE SAYS OTHERWISE, and
 * the discrepancy is recorded here rather than resolved silently. Measured
 * 2026-08-08 against the dev database:
 *
 *   schema        outbox table   relay role         in this table
 *   identity      yes            identity_relay     YES
 *   tms           yes            tms_relay          YES
 *   fulfillment   yes            fulfillment_relay  YES
 *   analytics     yes            analytics_relay    YES
 *   auth          yes            NONE               NO, see below
 *   orchestrator  yes            NONE               NO, empty and unwritten
 *   outbox_test   yes            n/a                NO, the library's own test schema
 *
 * AUTH IS DELIBERATELY EXCLUDED AND THIS IS NOT AN OVERSIGHT. auth.outbox is
 * live (22 unpublished rows when this was written) and carries
 * fct.auth.credential.v1, cfg.auth.credential.v1 and authz.audit. But no
 * `auth_relay` role has ever existed in ANY migration, spec or test, so
 * draining auth would mean minting an infra role for the platform's SOLE
 * SECRET-HOLDER and publishing credential-shaped facts onto a bus. That is an
 * architecture decision (S4, spec 04), not the wiring this task is scoped to,
 * and CLAUDE.md says to stop and escalate rather than improvise it.
 *
 * ORCHESTRATOR is excluded because its outbox has never been written to and it
 * has no relay role. Nothing to drain.
 *
 * Adding a context here is a two-part change: an entry below AND the matching
 * `<ctx>_relay` role with SELECT, UPDATE on that schema's outbox. There is no
 * ALTER DEFAULT PRIVILEGES anywhere in this platform, so no grant is implied by
 * any other grant.
 */
export interface RelayContext {
  /** Context name, used in logs and metrics. */
  readonly name: string
  /** The Postgres role the drain transaction runs under (SET LOCAL ROLE). */
  readonly role: string
  /** The env var holding this context's connection string. */
  readonly urlEnv: string
}

export const RELAY_CONTEXTS: readonly RelayContext[] = [
  { name: 'identity', role: 'identity_relay', urlEnv: 'IDENTITY_DATABASE_URL' },
  { name: 'tms', role: 'tms_relay', urlEnv: 'TMS_DATABASE_URL' },
  { name: 'fulfillment', role: 'fulfillment_relay', urlEnv: 'FULFILLMENT_DATABASE_URL' },
  { name: 'analytics', role: 'analytics_relay', urlEnv: 'ANALYTICS_DATABASE_URL' },
]

/**
 * Role names are interpolated into `SET LOCAL ROLE`, which cannot be
 * parameterised. They are compile-time constants above and never user input,
 * but this asserts the shape anyway so a future entry cannot smuggle anything
 * through that seam. Called once at startup, so a bad entry fails the process
 * rather than the first drain.
 */
const SAFE_ROLE = /^[a-z_][a-z0-9_]*$/

export function assertRelayContextsAreSafe(contexts: readonly RelayContext[] = RELAY_CONTEXTS): void {
  for (const c of contexts) {
    if (!SAFE_ROLE.test(c.role)) {
      throw new Error(`relay context "${c.name}" has an unsafe role name: ${c.role}`)
    }
  }
}
