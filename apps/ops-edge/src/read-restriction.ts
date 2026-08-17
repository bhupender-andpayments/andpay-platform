import { ForbiddenException } from '@nestjs/common'
import type { LeanClaim } from '@andpay/authz'

// The FIRST read-side restriction on the ops edge (DAMAGE_PLAN B6/DP-8, D-29,
// 16 Aug 2026), and WHY it is a role-keyed deny list rather than permissions:
//
// This repo has a standing convention that read-side permission strings are
// never minted (services/fulfillment/src/ops-config.ts records it at every
// absent `-list` entry): reads on this edge are guard-only (an authenticated
// class-3 operator), with no D2 authorize and no 6e. D-29 then adds
// customer_support, a role that may flag damage and view working lists but
// must have NO binary downloads, NO CSV export, and NO config views. A read
// permission vocabulary just for one role would invert the convention for the
// whole read plane; instead the edge carries this one narrow, fail-closed
// deny list keyed on the role name, applied ONLY to the download/export/config
// routes DP-8 names. Everything else customer_support needs stays guard-only.
//
// The role name is extracted from the VERIFIED claim's psr ('role:<name>',
// the same 'role:' prefix packages/authz/src/evaluate.ts authorizeHuman
// strips), never from a request body (M7/S16, D99). The throw is the same
// bare ForbiddenException the guard and controllers use: a generic 403 with
// no detail (S4/5c).
export const READ_RESTRICTED_ROLES: ReadonlySet<string> = new Set(['customer_support'])

export function requireUnrestrictedRead(claim: LeanClaim): void {
  const role = claim.psr.startsWith('role:') ? claim.psr.slice('role:'.length) : claim.psr
  if (READ_RESTRICTED_ROLES.has(role)) throw new ForbiddenException()
}
