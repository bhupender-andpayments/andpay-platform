import { newId, toUuid, fromUuid } from '@andpay/ids'
import { instanceKey, stepKey } from '@andpay/keys'
import { enqueue } from '@andpay/outbox'
import {
  resolveEdgeCredential,
  validateVendorSet,
  AuthzError,
  type LeanClaim,
  type Mode,
  type CredentialProjectionRow,
} from '@andpay/authz'
import type { AuthDb } from './db.js'
import type { PepperPort } from './ports/pepper.js'
import { mintSecret } from './secret.js'
import { credentialFactEnvelope, AUTH_CREDENTIAL_TOPIC } from './events.js'
import { loadDenylist } from './denylist.js'
import { emitAuthzAudit } from './audit.js'
import { requireStepUp } from './stepup.js'
import { STEP_UP_CATALOG } from './config/step-up-catalog.js'
import { VENDOR_SETS } from './config/vendor-sets.js'
import { VENDOR_PLANE } from './config/audiences.js'

const CREATE_FLOW = 'auth.vendor_credential.create'

export interface IssueVendorCredentialInput {
  vndrId: string
  workQueue: string
  permissionSetRef: string
  mode: Mode
  idempotencyKey: string
}

export interface CredentialActor {
  operatorId: string
  claim: LeanClaim
}

export interface IssueCredentialDeps {
  db: AuthDb
  pepper: PepperPort
  traceId: string
  now?: number
}

export interface IssueResult {
  apiId: string
  secret: string
  reused: boolean
}

// Issue a class-6 vendor credential (105, 5a-5e). An INTERNAL operator action
// (class 3, logged actor-on-behalf, 105e), never self-service. The show-once
// secret is returned to the caller and stored only as a peppered HMAC (5c). The
// lifecycle fact commits with the row (E1). Idempotent on a deterministic 06.A
// key: a retry mints no second secret (Section 10).
export async function issueVendorCredential(
  input: IssueVendorCredentialInput,
  actor: CredentialActor,
  deps: IssueCredentialDeps,
): Promise<IssueResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000)

  const stepUp = STEP_UP_CATALOG['vendor_credential:create']
  if (stepUp) requireStepUp(actor.claim, stepUp, now)

  const setName = input.permissionSetRef.replace(/^vset:/, '')
  const set = VENDOR_SETS[setName]
  if (!set) throw new AuthzError('unknown-vendor-set')
  // Defensive re-check of the config-load guard: the set is class-6-legal (105d).
  validateVendorSet(set.permissions)

  const idemKey = instanceKey(input.idempotencyKey, CREATE_FLOW)

  const prior = await deps.db.vendorCredential.findUnique({ where: { idempotencyKey: idemKey } })
  if (prior) {
    // A retry: the show-once secret is not re-revealable, so return only the id.
    return { apiId: fromUuid('api', prior.apiId), secret: '', reused: true }
  }

  const apiId = newId('api')
  const { secret, fingerprint } = mintSecret(input.mode)
  const pepperedHash = deps.pepper.hmac(secret)

  await deps.db.$transaction(async (tx) => {
    await tx.vendorCredential.create({
      data: {
        apiId: toUuid(apiId),
        pepperedHash,
        fingerprint,
        vndrId: toUuid(input.vndrId),
        workQueue: input.workQueue,
        permissionSetRef: input.permissionSetRef,
        mode: input.mode,
        epoch: 1,
        status: 'ACTIVE',
        issuedBy: actor.operatorId,
        idempotencyKey: idemKey,
      },
    })
    const env = credentialFactEnvelope({
      payload: { apiId, vndrRef: input.vndrId, status: 'ACTIVE', epoch: 1, mode: input.mode },
      dedupKey: idemKey,
      traceId: deps.traceId,
    })
    await enqueue(tx, {
      aggregateType: 'auth_credential',
      aggregateId: apiId,
      eventType: AUTH_CREDENTIAL_TOPIC,
      partitionKey: apiId,
      payload: env,
    })
    await emitAuthzAudit(tx, {
      principalId: actor.operatorId,
      cls: actor.claim.cls,
      operation: 'vendor_credential:create',
      decision: 'ALLOW',
      outcome: 'issued',
      resourceIds: [apiId, input.vndrId],
      acr: actor.claim.acr,
      authTime: actor.claim.auth_time,
      traceId: deps.traceId,
    })
  })

  return { apiId, secret, reused: false }
}

export interface RevokeDeps {
  db: AuthDb
  traceId: string
  now?: number
}

// Status-based revoke (5d): revoked is a STATUS, never a delete. Emits the
// lifecycle fact so downstream reacts. The denylist is the separate immediate
// kill channel (D3).
export async function revokeVendorCredential(apiId: string, deps: RevokeDeps): Promise<void> {
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  await deps.db.$transaction(async (tx) => {
    const cred = await tx.vendorCredential.update({
      where: { apiId: toUuid(apiId) },
      data: { status: 'REVOKED', rotatedAt: new Date(now * 1000) },
    })
    const env = credentialFactEnvelope({
      payload: { apiId, vndrRef: fromUuid('vndr', cred.vndrId), status: 'REVOKED', epoch: cred.epoch, mode: cred.mode },
      dedupKey: stepKey(apiId, 'revoke'),
      traceId: deps.traceId,
    })
    await enqueue(tx, {
      aggregateType: 'auth_credential',
      aggregateId: apiId,
      eventType: AUTH_CREDENTIAL_TOPIC,
      partitionKey: apiId,
      payload: env,
    })
  })
}

export interface ResolveDeps {
  db: AuthDb
  // The raw 5c pepper (injected at the verifier plane). Passed to the shared
  // @andpay/authz resolver, which computes the HMAC and looks it up.
  pepper: string | Buffer
  expectedMode: Mode
  now?: number
}

// Resolve an apsk_ secret to the uniform class-6 claim using the SHARED
// @andpay/authz resolver (the same fail-closed code every verifier runs). In
// production the vendor edge holds an async-replicated projection in memory;
// here the vendor_credential table IS the projection, loaded per call.
export async function resolveVendorCredential(secret: string, deps: ResolveDeps): Promise<LeanClaim> {
  const rows = await deps.db.vendorCredential.findMany({})
  const byHash = new Map<string, CredentialProjectionRow>(
    rows.map((r) => [
      r.pepperedHash,
      {
        apiId: fromUuid('api', r.apiId),
        vndrId: fromUuid('vndr', r.vndrId),
        workQueue: r.workQueue,
        permissionSetRef: r.permissionSetRef,
        mode: r.mode as Mode,
        status: r.status as 'ACTIVE' | 'REVOKED',
        epoch: r.epoch,
      },
    ]),
  )
  const denylist = await loadDenylist(deps.db)
  return resolveEdgeCredential(secret, {
    pepper: deps.pepper,
    lookup: (h) => byHash.get(h),
    denylist,
    expectedPlane: VENDOR_PLANE,
    expectedMode: deps.expectedMode,
    now: deps.now,
  })
}
