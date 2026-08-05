import { AuthzError, type Acr, type RoleConfig } from '@andpay/authz'
import type { AuthDb } from './db.js'
import { hashToken, rotateRefresh } from './refresh.js'

// The cookie-only session-rehydrate composition (Phase 7, GATE 2, S1). A cold
// browser reload has ALREADY lost its in-memory access token, so unlike
// refresh() there is NO bearer to bind and NO boundSub known up front. This
// function derives the principal FROM the presented refresh cookie itself and
// composes resolve -> ACTIVE-check -> rotate in the ONE order that keeps the
// audit accurate: it resolves the family's principal C4-internally FIRST (a
// read-only tokenHash lookup, never spending the rotation), enforces the
// principal is ACTIVE and its role is known BEFORE calling rotateRefresh, and
// only then rotates. Because rotateRefresh emits the refresh-ALLOW audit INSIDE
// its own rotation tx, gating that call behind the ACTIVE check means a
// deactivated or absent principal 401s BEFORE any rotation is spent and BEFORE
// any refresh-ALLOW audit is emitted (never a false ALLOW, never a burned
// rotation). refresh() and rotateRefresh are left byte-unchanged; this is a new
// composition over the existing rotateRefresh, and the edge stays token-blind
// (it never hashes the token or reads refresh_token; all resolution lives here).
export interface RehydrateDeps {
  db: AuthDb
  // The class-3 human role config (S15, D2): maps the principal's role to its
  // required assurance floor. Resolved LOCALLY (T4), exactly as refresh() reads
  // this.deps.roleConfig.roles[role].
  roleConfig: RoleConfig
  // Refresh-family idle window in seconds; forwarded verbatim to rotateRefresh.
  idleSec: number
  now?: number
  // The correlation id stamped into the co-committed 6e audit records.
  traceId: string
}

export interface RehydrateResult {
  refreshToken: string
  principalId: string
  role: string
  acr: Acr
}

// Rehydrate a class-3 session from the presented refresh cookie ALONE.
// Rotation semantics are identical to rotateRefresh (reused/revoked/idle/
// absolute-expired all throw AuthzError, mapped to a generic 401 at the edge;
// reuse still revokes the whole family with its DENY audit). Throws AuthzError
// on an unknown token, a wrong-principal-type token, or a non-ACTIVE / absent /
// unknown-role principal, so every failure surfaces as the same opaque 401.
export async function rehydrateSession(presented: string, deps: RehydrateDeps): Promise<RehydrateResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000)

  // (a) Resolve the family principal C4-internally, WITHOUT spending the
  // rotation. This is a plain read by tokenHash (the SAME primitive rotateRefresh
  // and logout use, T2), so the token never leaves the service. The reuse /
  // revoked / idle / absolute enforcement is deliberately NOT duplicated here;
  // it stays owned by rotateRefresh below. An unknown token, or a token from the
  // OTHER principal_type, is treated identically to a genuinely unknown token
  // (refresh-unknown), so no information about the vendor family space leaks
  // across the type boundary (mirrors rotateRefresh's own disjointness).
  const row = await deps.db.refreshToken.findUnique({ where: { tokenHash: hashToken(presented) } })
  if (!row || row.principalType !== 'internal') throw new AuthzError('refresh-unknown')

  // (b) Enforce the principal is ACTIVE and its role is known BEFORE the rotation
  // is spent. The refresh_token row carries neither acr/amr nor the role, and no
  // Session row is written at login, so the principal row is the only durable
  // source. A deactivated / deleted principal must not silently re-authenticate
  // by reloading, so a non-ACTIVE / absent / unknown-role principal 401s here,
  // before rotateRefresh is called, hence before any rotation is spent and before
  // any refresh-ALLOW audit is emitted. The achieved acr equals the role floor
  // for every class-3 session that can exist in v1 (AAL3 is unreachable, so a
  // login reaches EXACTLY its floor), so the role floor IS the assurance the
  // session had. Identical re-derivation to refresh(), sourced from the family's
  // own principalId instead of a bearer's boundSub.
  const principal = await deps.db.internalPrincipal.findUnique({ where: { id: row.principalId } })
  if (!principal || principal.status !== 'ACTIVE') throw new AuthzError('refresh-unknown')
  const role = deps.roleConfig.roles[principal.role]
  if (!role) throw new AuthzError('refresh-unknown')
  const acr: Acr = role.requiredAcr

  // (c) Rotate the family. rotateRefresh re-resolves the row by tokenHash and
  // enforces reuse (family-wide revoke) / revoked / idle / absolute, all -> 401.
  // The refresh-ALLOW audit co-commits INSIDE the successful-claim tx and the
  // reuse-revoke DENY audit co-commits INSIDE the revoke tx (S15/check-4), both
  // with principalId = the family's OWN principal (row.principalId), never an
  // external boundSub. An aborted rotation therefore leaves 0 new refresh rows
  // AND 0 authz.audit rows.
  const { refreshToken } = await rotateRefresh(presented, {
    db: deps.db,
    idleSec: deps.idleSec,
    now,
    audit: {
      principalId: row.principalId,
      cls: 3,
      operation: 'refresh',
      decision: 'ALLOW',
      resourceIds: [],
      outcome: 'rotated',
      acr,
      traceId: deps.traceId,
    },
    revokeAudit: {
      principalId: row.principalId,
      cls: 3,
      operation: 'refresh',
      decision: 'DENY',
      resourceIds: [],
      outcome: 'reuse-family-revoked',
      reasonCode: 'refresh-reuse',
      traceId: deps.traceId,
    },
  })

  // (d) Hand the controller exactly what it needs to mint the successor access
  // token: the rotated refresh token (for the Set-Cookie), the family principal,
  // and the re-derived role + acr (so the edge does not re-read the principal).
  return { refreshToken, principalId: row.principalId, role: principal.role, acr }
}
