// Demo local runtime (throwaway, branch demo/ops-portal-skin). Boots auth-edge
// (:3000) and ops-edge (:3001) in ONE process with ONE shared ES256 signer, so
// tokens auth mints verify at ops against the same public JWKS. Seeds the
// operator principal (Argon2id password + admin-seeded TOTP into the same
// in-process vault the login path reads) and injects a demo roleConfig into
// ops-edge that maps the auth human role `admin` to the ops write permissions
// (the auth-role vs ops-role vocabulary mismatch is a real integration seam;
// the bridge lives ONLY in demo tooling, the edge still authorizes).
import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { hash as argonHash } from '@node-rs/argon2'
import { authenticator } from 'otplib'
import {
  PrismaClient as AuthClient,
  LocalEs256Adapter,
  TotpAdapter,
  enrollTotp,
  loadConfig,
} from '@andpay/auth-service'
import { buildAuthEdgeApp, NoThrottle } from '@andpay/auth-edge'
import { buildOpsEdgeApp, buildOpsEdgeDepsFromEnv } from '@andpay/ops-edge'
import { humanRole } from '@andpay/authz'
import { OPERATORS, AUTH_DB_URL, TOTP_ISSUER } from './operators.mjs'

const ISS = 'andpay-auth'
const SPA_ORIGIN = 'http://localhost:5173'
const AUTH_PORT = 3000
const OPS_PORT = 3001
const HERE = dirname(fileURLToPath(import.meta.url))

// The 13 ops write permissions (services/fulfillment/src/ops-config.ts). The
// demo maps the auth `admin` role to all of them so a logged-in admin can
// exercise every write and the step-up destructive actions.
const OPS_PERMS = [
  'ops:upload-bank-file',
  'ops:upload-damage-file',
  'ops:status-correction',
  'ops:terminal-override',
  'ops:recompose-artifact',
  'ops:record-hold',
  'ops:record-release',
  'ops:manual-batch-trigger',
  'ops:vendor-create',
  'ops:vendor-suspend',
  'ops:resolve-quarantine',
  'ops:resolve-intake-exception',
  'ops:resolve-status-exception',
]

function extractSecret(otpauthUri) {
  const m = /[?&]secret=([^&]+)/.exec(otpauthUri)
  if (!m || !m[1]) throw new Error('otpauth uri missing secret')
  return decodeURIComponent(m[1])
}

async function main() {
  const authDb = new AuthClient({ datasourceUrl: AUTH_DB_URL })

  // One shared signer: auth signs, ops verifies against signer.jwks().
  const signer = await LocalEs256Adapter.create('demo-1')
  const jwks = await signer.jwks()

  // The in-process custody vault: storeSecret (enroll) and mfaSecretResolver
  // (login) share this ONE map, so a TOTP enrolled at boot resolves at login.
  const vault = new Map()
  const storeSecret = async (principalId, secret) => {
    const ref = `vault://${principalId}`
    vault.set(ref, secret)
    return ref
  }
  const mfaSecretResolver = async (principalId) => vault.get(`vault://${principalId}`)

  // Provision each operator fresh (idempotent per boot): clear its old MFA /
  // sessions, upsert the principal with a known Argon2id password, enroll a
  // TOTP into the shared vault.
  const provisioned = []
  for (const op of OPERATORS) {
    await authDb.mfaEnrollment.deleteMany({ where: { principalId: op.id } })
    await authDb.refreshToken.deleteMany({ where: { principalId: op.id } })
    await authDb.session.deleteMany({ where: { principalId: op.id } })
    await authDb.internalPrincipal.upsert({
      where: { id: op.id },
      update: { loginHandle: op.handle, passwordHash: await argonHash(op.password), status: 'ACTIVE', role: op.role },
      create: {
        id: op.id,
        loginHandle: op.handle,
        passwordHash: await argonHash(op.password),
        status: 'ACTIVE',
        role: op.role,
      },
    })
    const { otpauthUri } = await enrollTotp(authDb, {
      targetPrincipalId: op.id,
      targetAccountLabel: op.handle,
      enrolledByActor: randomUUID(),
      issuer: TOTP_ISSUER,
      storeSecret,
      traceId: randomUUID(),
    })
    provisioned.push({ ...op, secret: extractSecret(otpauthUri), otpauthUri })
  }

  // Write throwaway TOTP secrets so `demo:code` can print live codes.
  writeFileSync(
    join(HERE, '.demo-totp.json'),
    JSON.stringify(provisioned.map((p) => ({ handle: p.handle, secret: p.secret })), null, 2),
  )

  // auth-edge deps (hand-built so we control the shared signer + vault).
  const authDeps = {
    authDb,
    signer,
    jwks,
    mfa: new TotpAdapter(),
    mfaSecretResolver,
    storeSecret,
    expectedIss: ISS,
    expectedMode: 'live',
    roleConfig: loadConfig(),
    accessTtlSec: 600,
    idleSec: 1800,
    absoluteSec: 28800,
    totpIssuer: TOTP_ISSUER,
    portalOrigin: SPA_ORIGIN,
    throttle: NoThrottle,
  }
  const authApp = await buildAuthEdgeApp(authDeps)
  await authApp.init()
  await authApp.listen(AUTH_PORT)

  // ops-edge deps from env (shares the signer's JWKS + issuer), then override
  // the role config with the demo bridge (admin -> ops permissions).
  process.env.OPS_EDGE_JWKS = JSON.stringify(jwks)
  process.env.OPS_EDGE_ISS = ISS
  process.env.OPS_PORTAL_ORIGIN = SPA_ORIGIN
  const opsDeps = buildOpsEdgeDepsFromEnv()
  opsDeps.roleConfig = {
    roles: { admin: humanRole({ permissions: OPS_PERMS, ceiling: 'all-programs', requiredAcr: 'AAL2' }) },
    vendorSets: {},
  }
  const opsApp = await buildOpsEdgeApp(opsDeps)
  await opsApp.init()
  await opsApp.listen(OPS_PORT)

  console.log('\n=== ops-portal demo runtime up ===')
  console.log(`auth-edge : http://localhost:${AUTH_PORT}`)
  console.log(`ops-edge  : http://localhost:${OPS_PORT}`)
  console.log(`SPA origin: ${SPA_ORIGIN} (run: pnpm --filter @andpay/ops-portal dev)`)
  console.log('\noperator login(s):')
  for (const p of provisioned) {
    console.log(`  handle:   ${p.handle}`)
    console.log(`  password: ${p.password}`)
    console.log(`  TOTP secret (base32): ${p.secret}`)
    console.log(`  current code:         ${authenticator.generate(p.secret)}  (rotates every 30s; run demo:code for a fresh one)`)
  }
  console.log('\nkeep this process running. Ctrl-C to stop.\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
