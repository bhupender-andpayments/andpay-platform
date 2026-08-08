import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { authenticator } from 'otplib'
import { newId } from '@andpay/ids'
import { verifyAccessToken } from '@andpay/authz'
import { PrismaClient, type AuthDb } from '../src/index.js'
import { LocalEs256Adapter, type KmsSigningPort } from '../src/ports/kms-signing.js'
import { INTERNAL_ADMIN_PLANE, VENDOR_PLANE } from '../src/config/audiences.js'
import { TotpAdapter } from '../src/ports/mfa.js'
import { provisionVendorOperator } from '../src/vendor-operator.js'
import { AUTH_ISS } from '../src/index.js'
import { vendorLogin, type VendorLoginDeps } from '../src/vendor-login.js'

// Spec 14a Task 6: class-7 vendor-operator login. Mirrors login.ts's
// structure (uniform-failure DENY, synchronous-standalone 6e before throw,
// AAL2 floor) but is a SEPARATE module: login.ts is not touched (D6).
const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
let db: AuthDb
let internalSigner: LocalEs256Adapter
let vendorSigner: LocalEs256Adapter
let signer: KmsSigningPort // the aud-selecting multi-key signer (Task 2, Fork D)

const totpSecret = authenticator.generateSecret()
let vndrId: string
let username: string
let operatorId: string

beforeAll(async () => {
  db = new PrismaClient({ datasourceUrl: url })
  internalSigner = await LocalEs256Adapter.create('int-1')
  vendorSigner = await LocalEs256Adapter.create('vendor-1')
  signer = LocalEs256Adapter.createMulti({
    [INTERNAL_ADMIN_PLANE]: internalSigner,
    [VENDOR_PLANE]: vendorSigner,
  })
})
afterAll(async () => {
  await db.$disconnect()
})
beforeEach(async () => {
  // SCOPED to the usernames this suite mints, never the whole table.
  //
  // The unfiltered `TRUNCATE vendor_operator ... CASCADE` that used to be here
  // deleted operators belonging to OTHER suites. apps/vendor-auth-edge seeds
  // its operator ONCE in beforeAll and logs in later, so whenever this file ran
  // in between, that login came back 401 and the failure surfaced far away
  // from its cause. Root vitest is fileParallelism:false, so file ORDER alone
  // decided whether it bit, which is exactly why it read as flake (F-1).
  //
  // The two sides never actually collide: this suite mints `op-<uuid>` and
  // vendor-auth-edge seeds `operator_<suffix>`, so scoping costs this suite
  // nothing. CASCADE was covering nothing either: no foreign key references
  // vendor_operator (checked against the live schema).
  await db.$executeRawUnsafe(`DELETE FROM vendor_operator WHERE username LIKE 'op-%'`)
  await db.$executeRawUnsafe('TRUNCATE outbox')
  // refresh_token is SCOPED to this suite's own principal_type, matching the
  // mfa_enrollment delete on the very next line, which was already scoped this
  // way. The unfiltered TRUNCATE that used to be here also took every INTERNAL
  // session with it, logging the developer out of the running demo portal on
  // every gate run. This suite only ever asserts on vendor_operator rows.
  await db.$executeRawUnsafe(`DELETE FROM refresh_token WHERE principal_type = 'vendor_operator'`)
  await db.$executeRawUnsafe(`DELETE FROM mfa_enrollment WHERE principal_type = 'vendor_operator'`)
  vndrId = newId('vndr')
  username = `op-${randomUUID()}`
  const { id } = await provisionVendorOperator(db, {
    vndrId,
    username,
    password: 'correct horse battery staple',
    createdByActor: randomUUID(),
    traceId: 'trace-provision',
  })
  operatorId = id
  // A vendor operator's factor exists only when an ACTIVE enrollment row says
  // so, exactly as on the internal plane: the custody stub alone is not an
  // enrollment. vendorLogin shares the same resolveActiveFactorSecret gate, so
  // without this row a valid code correctly fails to verify.
  await db.mfaEnrollment.create({
    data: {
      id: randomUUID(),
      principalId: operatorId,
      principalType: 'vendor_operator',
      factor: 'totp',
      secretRef: 'ref-vendor',
      status: 'active',
      enrolledByActor: randomUUID(),
    },
  })
})

function deps(): VendorLoginDeps {
  return {
    db,
    signer,
    mfa: new TotpAdapter(),
    resolveSecretRef: async (ref: string) => (ref === 'ref-vendor' ? totpSecret : undefined),
    iss: AUTH_ISS,
    accessTtlSec: 600,
    idleSec: 1800,
    absoluteSec: 28800,
    clientBind: 'client-A',
    traceId: 'trace-vendor-login',
  }
}

describe('vendorLogin (spec 14a task 6, class-7)', () => {
  it('password + TOTP mints a cls:7 token with scope.vndr from the stored row, verifiable against the vendor JWKS key', async () => {
    const res = await vendorLogin(username, 'correct horse battery staple', authenticator.generate(totpSecret), deps())
    expect(res.accessToken).toBeTruthy()
    expect(res.refreshToken).toBeTruthy()

    const claim = await verifyAccessToken(res.accessToken, {
      jwks: await vendorSigner.jwks(),
      expectedIss: AUTH_ISS,
      expectedAud: 'andpay:vendor',
    })
    expect(claim.cls).toBe(7)
    expect(claim.aud).toBe('andpay:vendor')
    expect(claim.scope.vndr).toBe(vndrId)
    expect(claim.acr).toBe('AAL2')
    expect(claim.amr).toEqual(['pwd', 'otp'])
    expect(claim.mode).toBe('live')
    expect(claim.psr.startsWith('vset:')).toBe(true)
  })

  it('denies password-only (AAL2 floor, no second factor presented)', async () => {
    await expect(vendorLogin(username, 'correct horse battery staple', undefined, deps())).rejects.toThrow()
  })

  it('denies a SUSPENDED operator even with correct password + TOTP', async () => {
    await db.vendorOperator.update({ where: { id: operatorId }, data: { status: 'SUSPENDED' } })
    await expect(
      vendorLogin(username, 'correct horse battery staple', authenticator.generate(totpSecret), deps()),
    ).rejects.toThrow()
  })

  it('ignores a caller-supplied vndr; scope is always re-derived server-side from the stored row', async () => {
    const attackerVndr = newId('vndr')
    const res = await vendorLogin(
      username,
      'correct horse battery staple',
      authenticator.generate(totpSecret),
      // @ts-expect-error vndr is not part of the vendorLogin signature; this
      // proves there is no back-door input field to smuggle a scope through.
      { ...deps(), vndr: attackerVndr },
    )
    const claim = await verifyAccessToken(res.accessToken, {
      jwks: await vendorSigner.jwks(),
      expectedIss: AUTH_ISS,
      expectedAud: 'andpay:vendor',
    })
    expect(claim.scope.vndr).toBe(vndrId)
    expect(claim.scope.vndr).not.toBe(attackerVndr)
  })

  it('a DENY commits its synchronous-standalone 6e audit BEFORE the throw is observable', async () => {
    await expect(vendorLogin(username, 'wrong password', authenticator.generate(totpSecret), deps())).rejects.toThrow()

    const audits = await db.outbox.findMany({ where: { eventType: 'authz.audit' } })
    const denyAudit = audits.find(
      (a) => JSON.stringify(a.payload).includes('"decision":"DENY"') && JSON.stringify(a.payload).includes(operatorId),
    )
    expect(denyAudit).toBeDefined()
    const json = JSON.stringify(denyAudit!.payload)
    expect(json.includes('wrong password')).toBe(false)
  })

  it('opens a real vendor refresh family (principal_type vendor_operator) on success', async () => {
    await vendorLogin(username, 'correct horse battery staple', authenticator.generate(totpSecret), deps())

    const rows = await db.refreshToken.findMany({ where: { principalId: operatorId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.principalType).toBe('vendor_operator')
  })
})
