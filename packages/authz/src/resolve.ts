import { createHmac } from 'node:crypto'
import type { LeanClaim, Mode, Plane } from './claims.js'
import { AuthzError } from './errors.js'
import { isDenylisted } from './denylist.js'

// The async-replicated, integrity-protected credential projection row (5e). It
// carries the resolved attributes only; the peppered hash is the lookup key
// (below), never a field the caller reads back.
export interface CredentialProjectionRow {
  apiId: string
  vndrId: string
  workQueue: string
  permissionSetRef: string
  mode: Mode
  status: 'ACTIVE' | 'REVOKED'
  epoch: number
  // Seconds since epoch. Absent means no expiry.
  expiresAt?: number
}

export interface ResolveOptions {
  // The 5c pepper, injected at runtime by the edge process. This library never
  // bundles or stores it (the @andpay/authz DO-NOT).
  pepper: Buffer | string
  // One local lookup by the peppered hash (the unique index IS the compare, 5c:
  // one HMAC plus one index hit). Zero network calls per request (5e).
  lookup: (pepperedHashHex: string) => CredentialProjectionRow | undefined
  denylist?: ReadonlySet<string>
  // The plane this edge serves; class 6 is always andpay:vendor (105f).
  expectedPlane: Plane
  // The live/test plane this edge serves; a mismatch is rejected like an aud
  // mismatch (5b/5e).
  expectedMode: Mode
  // Seconds since epoch; override for deterministic tests.
  now?: number
}

function parseMode(secret: string): Mode | undefined {
  if (secret.startsWith('apsk_live_')) return 'live'
  if (secret.startsWith('apsk_test_')) return 'test'
  return undefined
}

// Resolve an api_/apsk_ edge credential LOCALLY to the uniform lean claim (5e):
// one HMAC over the injected pepper, one local lookup, zero network calls.
// Authentication is fail-closed, STRUCTURALLY: any unverifiable, revoked,
// expired, mode-mismatched, or denylisted credential is a denied credential,
// always, never an availability-appetite choice.
export function resolveEdgeCredential(presentedSecret: string, opts: ResolveOptions): LeanClaim {
  const presentedMode = parseMode(presentedSecret)
  if (presentedMode === undefined || presentedMode !== opts.expectedMode) {
    throw new AuthzError('mode-mismatch')
  }

  const pepperedHash = createHmac('sha256', opts.pepper).update(presentedSecret).digest('hex')
  const row = opts.lookup(pepperedHash)
  if (!row) throw new AuthzError('credential-unknown')
  if (row.status !== 'ACTIVE') throw new AuthzError('credential-revoked')
  if (row.mode !== opts.expectedMode) throw new AuthzError('mode-mismatch')

  const now = opts.now ?? Math.floor(Date.now() / 1000)
  if (row.expiresAt !== undefined && row.expiresAt <= now) throw new AuthzError('credential-expired')
  if (isDenylisted(row.apiId, opts.denylist)) throw new AuthzError('denylisted')

  return {
    iss: 'andpay-auth',
    sub: row.apiId,
    aud: opts.expectedPlane,
    iat: now,
    nbf: now,
    // An edge credential is resolved per request, not a time-bounded bearer
    // like a JWT; exp mirrors iat so the uniform claim shape stays satisfied.
    exp: now,
    jti: row.apiId,
    cls: 6,
    mode: row.mode,
    scope: { vndr: row.vndrId, wq: row.workQueue },
    psr: row.permissionSetRef,
    epoch: row.epoch,
    // No acr/amr/auth_time: assurance IS the credential, no MFA, no session (5f).
  }
}
