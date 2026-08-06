import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { hash as argonHash } from '@node-rs/argon2'
import { authenticator } from 'otplib'
import { verifyAccessToken } from '@andpay/authz'
import { PrismaClient } from '../generated/client/index.js'
import { LocalEs256Adapter } from '../src/ports/kms-signing.js'
import { TotpAdapter } from '../src/ports/mfa.js'
import { login, type LoginDeps } from '../src/login.js'
import { AUTH_ISS } from '../src/index.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
const db = new PrismaClient({ datasourceUrl: url })
let signer: LocalEs256Adapter
const totpSecret = authenticator.generateSecret()
const opsId = randomUUID()
// This suite runs against the SHARED dev database, which also holds the operator
// account the ops portal logs in with. So the fixture owns a per-run identity and
// the reset below deletes ONLY that identity. An unfiltered deleteMany({}) here
// wipes every principal and enrollment in the schema, which silently destroys the
// portal login for whoever is using it.
const opsHandle = `ops1-${opsId.slice(0, 8)}`

beforeAll(async () => {
  await db.$connect()
  signer = await LocalEs256Adapter.create('dev-1')
})
afterAll(async () => {
  // Leave the schema as we found it: without this the per-run fixture principal
  // accumulates one dead ops1-<tag> row in the shared dev database every run.
  await db.refreshToken.deleteMany({ where: { principalId: opsId } })
  await db.mfaEnrollment.deleteMany({ where: { principalId: opsId } })
  await db.internalPrincipal.deleteMany({ where: { id: opsId } })
  await db.$disconnect()
})
beforeEach(async () => {
  await db.refreshToken.deleteMany({ where: { principalId: opsId } })
  await db.mfaEnrollment.deleteMany({ where: { principalId: opsId } })
  await db.internalPrincipal.deleteMany({ where: { id: opsId } })
  await db.internalPrincipal.create({
    data: { id: opsId, loginHandle: opsHandle, passwordHash: await argonHash('correct horse battery'), status: 'ACTIVE', role: 'ops' },
  })
})

function deps(): LoginDeps {
  return {
    db,
    signer,
    mfa: new TotpAdapter(),
    resolveSecretRef: async (ref: string) => (ref === 'ref-test' ? totpSecret : undefined),
    iss: AUTH_ISS,
    accessTtlSec: 600,
    idleSec: 1800,
    absoluteSec: 28800,
    clientBind: 'client-A',
    traceId: 'trace-login',
  }
}

// An ACTIVE enrollment row is what makes a principal "already enrolled". The
// stubbed resolveSecretRef above is custody, not enrollment state: login reads
// the row, exactly as enrollTotp writes it.
async function seedActiveEnrollment(): Promise<void> {
  await db.mfaEnrollment.create({
    data: {
      id: randomUUID(),
      principalId: opsId,
      principalType: 'internal',
      factor: 'totp',
      secretRef: 'ref-test',
      status: 'active',
      enrolledByActor: randomUUID(),
    },
  })
}

describe('class-3 login and the acr gate end-to-end (check 2)', () => {
  it('answers mfaRequired (and issues NO session) without a second factor once enrolled', async () => {
    // The load-bearing security property is unchanged: for a principal that
    // ALREADY holds a factor, a password alone grants NOTHING. What changed is
    // only the shape of the answer: a "keep going" result instead of a throw,
    // so the caller can tell the operator their password was fine and ask for
    // the code, rather than failing vaguely one screen later.
    await seedActiveEnrollment()
    const res = await login(opsHandle, 'correct horse battery', undefined, deps())
    expect(res.mfaRequired).toBe(true)
    // No token, no refresh family, no session of any kind.
    expect(res.accessToken).toBeUndefined()
    expect(res.refreshToken).toBeUndefined()
    expect(await db.refreshToken.count({ where: { principalId: opsId } })).toBe(0)
  })

  it('returns an enrollment-only token (no refresh family) for a principal with no enrollment', async () => {
    const res = await login(opsHandle, 'correct horse battery', undefined, deps())
    expect(res.enrollmentRequired).toBe(true)
    // No session was opened: nothing to extend, nothing to set as a cookie.
    expect(res.refreshToken).toBeUndefined()
    expect(await db.refreshToken.count({ where: { principalId: opsId } })).toBe(0)
    expect(res.accessToken).toBeDefined()
    const claim = await verifyAccessToken(res.accessToken!, {
      jwks: await signer.jwks(),
      expectedIss: AUTH_ISS,
      expectedAud: 'andpay:internal-admin',
    })
    // The principal's real role is NEVER stamped on this token.
    expect(claim.psr).toBe('role:enrollment_pending')
    expect(claim.acr).toBe('AAL1')
  })

  it('rejects a valid TOTP once the enrollment is REVOKED (revocation actually revokes)', async () => {
    // Regression: custody used to be keyed on principalId alone and kept
    // returning the last-stored secret after a revoke, so login MUST gate
    // factor verification on an ACTIVE enrollment row. Without that gate a
    // revoked authenticator still signed in, and an admin resetting a
    // compromised factor left the old code working.
    await seedActiveEnrollment()
    await db.mfaEnrollment.updateMany({ where: { principalId: opsId }, data: { status: 'revoked' } })
    // The secret itself is still resolvable and the code is arithmetically
    // valid; only the enrollment state has changed.
    await expect(
      login(opsHandle, 'correct horse battery', authenticator.generate(totpSecret), deps()),
    ).rejects.toThrow('mfa-failed')
  })

  it('denies a WRONG totp rather than downgrading it into enrollment', async () => {
    // A bad code must stay a uniform mfa DENY. If a wrong code fell through to
    // the enrollment path, an attacker could reach enrollment by guessing.
    await expect(login(opsHandle, 'correct horse battery', '000000', deps())).rejects.toThrow()
  })

  it('issues a session with a valid password plus TOTP (AAL2)', async () => {
    // A real enrolled principal has BOTH an active enrollment row and a secret
    // in custody. Seeding only the custody stub modelled a state that cannot
    // occur, and login now (correctly) refuses to verify a factor that has no
    // active enrollment behind it.
    await seedActiveEnrollment()
    const res = await login(opsHandle, 'correct horse battery', authenticator.generate(totpSecret), deps())
    expect(res.acr).toBe('AAL2')
    expect(res.refreshToken).toBeTruthy()
    expect(res.accessToken).toBeDefined()
    const claim = await verifyAccessToken(res.accessToken!, {
      jwks: await signer.jwks(),
      expectedIss: AUTH_ISS,
      expectedAud: 'andpay:internal-admin',
    })
    expect(claim.cls).toBe(3)
    expect(claim.sub).toBe(opsId)
    expect(claim.psr).toBe('role:ops')
  })

  it('denies a wrong password (uniform authn failure)', async () => {
    await expect(login(opsHandle, 'wrong', authenticator.generate(totpSecret), deps())).rejects.toThrow()
  })
})
