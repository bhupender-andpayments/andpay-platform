import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet, type JWK, type KeyLike } from 'jose'
import { randomUUID } from 'node:crypto'

export interface SignInput {
  // The custom lean claims (cls, mode, scope, psr, epoch, acr, amr, auth_time).
  claims: Record<string, unknown>
  iss: string
  sub: string
  aud: string
  ttlSec: number
  now?: number
}

// The signing port (Section 4, swappable). ES256 only (D3, no symmetric
// signing). The live multi-region AWS KMS key (ap-south-1 primary, ap-south-2
// replica, same kid, D79) is a deploy-time adapter behind this same interface;
// verifiers hold only the JWKS public key and never call this port.
export interface KmsSigningPort {
  readonly kid: string
  sign(input: SignInput): Promise<string>
  jwks(): Promise<JSONWebKeySet>
}

// A local dev adapter: an in-process P-256 keypair. FOR TESTS AND LOCAL DEV
// ONLY; production signs via the AWS KMS adapter (deploy-deferred). The private
// key never leaves this process and never appears in the JWKS.
export class LocalEs256Adapter implements KmsSigningPort {
  readonly kid: string
  readonly #privateKey: KeyLike
  readonly #publicJwk: JWK

  private constructor(kid: string, privateKey: KeyLike, publicJwk: JWK) {
    this.kid = kid
    this.#privateKey = privateKey
    this.#publicJwk = publicJwk
  }

  static async create(kid = 'dev-1'): Promise<LocalEs256Adapter> {
    const kp = await generateKeyPair('ES256', { extractable: true })
    const publicJwk: JWK = { ...(await exportJWK(kp.publicKey)), kid, alg: 'ES256', use: 'sig' }
    return new LocalEs256Adapter(kid, kp.privateKey, publicJwk)
  }

  async sign(input: SignInput): Promise<string> {
    const now = input.now ?? Math.floor(Date.now() / 1000)
    return await new SignJWT(input.claims)
      .setProtectedHeader({ alg: 'ES256', kid: this.kid, typ: 'at+jwt' })
      .setIssuer(input.iss)
      .setSubject(input.sub)
      .setAudience(input.aud)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + input.ttlSec)
      .setJti(randomUUID())
      .sign(this.#privateKey)
  }

  async jwks(): Promise<JSONWebKeySet> {
    return { keys: [this.#publicJwk] }
  }
}
