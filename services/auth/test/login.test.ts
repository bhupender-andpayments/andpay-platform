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

beforeAll(async () => {
  await db.$connect()
  signer = await LocalEs256Adapter.create('dev-1')
})
afterAll(async () => {
  await db.$disconnect()
})
beforeEach(async () => {
  await db.refreshToken.deleteMany({})
  await db.mfaEnrollment.deleteMany({})
  await db.internalPrincipal.deleteMany({})
  await db.internalPrincipal.create({
    data: { id: opsId, loginHandle: 'ops1', passwordHash: await argonHash('correct horse battery'), status: 'ACTIVE', role: 'ops' },
  })
})

function deps(): LoginDeps {
  return {
    db,
    signer,
    mfa: new TotpAdapter(),
    mfaSecretResolver: async (id: string) => (id === opsId ? totpSecret : undefined),
    iss: AUTH_ISS,
    accessTtlSec: 600,
    idleSec: 1800,
    absoluteSec: 28800,
    clientBind: 'client-A',
    traceId: 'trace-login',
  }
}

describe('class-3 login and the acr gate end-to-end (check 2)', () => {
  it('denies login without a second factor (cannot reach the AAL2 platform floor)', async () => {
    await expect(login('ops1', 'correct horse battery', undefined, deps())).rejects.toThrow()
  })

  it('issues a session with a valid password plus TOTP (AAL2)', async () => {
    const res = await login('ops1', 'correct horse battery', authenticator.generate(totpSecret), deps())
    expect(res.acr).toBe('AAL2')
    expect(res.refreshToken).toBeTruthy()
    const claim = await verifyAccessToken(res.accessToken, {
      jwks: await signer.jwks(),
      expectedIss: AUTH_ISS,
      expectedAud: 'andpay:internal-admin',
    })
    expect(claim.cls).toBe(3)
    expect(claim.sub).toBe(opsId)
    expect(claim.psr).toBe('role:ops')
  })

  it('denies a wrong password (uniform authn failure)', async () => {
    await expect(login('ops1', 'wrong', authenticator.generate(totpSecret), deps())).rejects.toThrow()
  })
})
