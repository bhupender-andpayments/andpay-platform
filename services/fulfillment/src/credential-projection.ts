import { toUuid, fromUuid } from '@andpay/ids'
import { onceWithin } from '@andpay/outbox'
import type { Envelope } from '@andpay/envelope'
import type { CredentialProjectionRow } from '@andpay/authz'
import type { FulfillmentDb } from './db.js'
import type { Tx } from './internal.js'

// The 5c auth-config channel's payload, declared LOCALLY (C4): this consumer
// never imports @andpay/auth-service or anything from services/auth. This is
// Fulfillment's OWN byte-identical copy of the wire shape Auth's
// credential-config.ts (Task 4) actually emits on cfg.auth.credential.v1, kept
// honest by the Task-8 cross-context round-trip test (no cross-context
// import, drift caught structurally there rather than by a shared type). IDs,
// enums, and the peppered hash ONLY, never a raw secret or PII (S7/S4). apiId
// and vndrId are the typed wire ids (api_/vndr_), exactly as Auth's own
// enqueueCredentialConfig call site passes them; NO expiresAt (D3 class-6
// credentials do not expire).
export interface CredentialConfigPayload {
  apiId: string
  pepperedHash: string
  vndrId: string
  workQueue: string
  permissionSetRef: string
  mode: string
  status: string
  epoch: number
}

// The inbox consumer identity for this projection's E6 dedup, distinct from
// the shared context-wide CONSUMER (internal.ts) so a credential-config
// redelivery can never collide with an unrelated fulfillment consumer's
// dedup_key namespace.
export const CREDENTIAL_CONFIG_CONSUMER = 'fulfillment.credential-projection'

export interface ProjectCredentialConfigResult {
  upserted: boolean
}

/**
 * Upsert the LOCAL credential projection from one cfg.auth.credential.v1
 * envelope (5c, check 1). Dedups on env.dedupKey via onceWithin (E6): Task 4's
 * dedupKey is stepKey(apiId, status.toLowerCase(), epoch), so an ACTIVE event
 * and a later REVOKED event carry DIFFERENT dedupKeys and both apply (the row
 * ends REVOKED), while a redelivered copy of the SAME event is a no-op.
 * api_id is the PRIMARY KEY, so ON CONFLICT (api_id) always updates the one
 * row per credential in place; peppered_hash is immutable per credential in
 * practice (a rotation mints a new apiId), but is re-written on every apply
 * for defensiveness. updated_at is always stamped now() on write.
 */
export async function projectCredentialConfig(
  db: FulfillmentDb,
  env: Envelope<CredentialConfigPayload>,
): Promise<ProjectCredentialConfigResult> {
  const p = env.payload
  const apiUuid = toUuid(p.apiId)
  const vndrUuid = toUuid(p.vndrId)
  const upserted = await db.$transaction(async (tx: Tx) => {
    return onceWithin(tx, CREDENTIAL_CONFIG_CONSUMER, env.dedupKey, async () => {
      await tx.$executeRaw`
        INSERT INTO credential_projection (
          api_id, peppered_hash, vndr_id, work_queue, permission_set_ref, mode, status, epoch, updated_at
        ) VALUES (
          ${apiUuid}::uuid, ${p.pepperedHash}, ${vndrUuid}::uuid, ${p.workQueue}, ${p.permissionSetRef}, ${p.mode}, ${p.status}, ${p.epoch}, now()
        )
        ON CONFLICT (api_id) DO UPDATE SET
          peppered_hash = EXCLUDED.peppered_hash,
          vndr_id = EXCLUDED.vndr_id,
          work_queue = EXCLUDED.work_queue,
          permission_set_ref = EXCLUDED.permission_set_ref,
          mode = EXCLUDED.mode,
          status = EXCLUDED.status,
          epoch = EXCLUDED.epoch,
          updated_at = now()
      `
    })
  })
  return { upserted }
}

interface CredentialProjectionQueryRow {
  api_id: string
  vndr_id: string
  work_queue: string
  permission_set_ref: string
  mode: string
  status: string
  epoch: number
}

/**
 * The resolve-side lookup closure (5c/5e): one HMAC over the runtime-injected
 * pepper (the caller's job, this function never sees the raw secret or the
 * pepper), one local lookup by the peppered hash, zero network calls. Returns
 * undefined for an unknown hash, exactly the shape @andpay/authz's
 * resolveEdgeCredential expects. apiId/vndrId are reconstructed to their typed
 * wire form (api_/vndr_) via fromUuid, matching services/auth's own
 * resolveVendorCredential (the in-memory reference implementation of this same
 * lookup), so the resulting LeanClaim.sub/scope.vndr are wire ids exactly like
 * every other class-6 claim in this codebase.
 */
export function credentialLookup(
  db: FulfillmentDb,
): (pepperedHashHex: string) => Promise<CredentialProjectionRow | undefined> {
  return async (pepperedHashHex: string): Promise<CredentialProjectionRow | undefined> => {
    const rows = await db.$queryRaw<CredentialProjectionQueryRow[]>`
      SELECT api_id::text AS api_id, vndr_id::text AS vndr_id, work_queue, permission_set_ref, mode, status, epoch
      FROM credential_projection WHERE peppered_hash = ${pepperedHashHex}
    `
    const row = rows[0]
    if (!row) return undefined
    return {
      apiId: fromUuid('api', row.api_id),
      vndrId: fromUuid('vndr', row.vndr_id),
      workQueue: row.work_queue,
      permissionSetRef: row.permission_set_ref,
      mode: row.mode as CredentialProjectionRow['mode'],
      status: row.status as 'ACTIVE' | 'REVOKED',
      epoch: Number(row.epoch),
      // No expires_at column (see the CredentialProjection model comment).
      expiresAt: undefined,
    }
  }
}
