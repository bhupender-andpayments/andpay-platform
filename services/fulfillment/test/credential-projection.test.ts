import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { stepKey } from '@andpay/keys'
import { PrismaClient } from '../generated/client/index.js'
import {
  projectCredentialConfig,
  credentialLookup,
  CREDENTIAL_CONFIG_CONSUMER,
  type CredentialConfigPayload,
} from '../src/credential-projection.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  // credential_projection plus the inbox rows this consumer owns, so the
  // suite is re-runnable (E6 inbox rows otherwise persist across runs).
  await db.$executeRawUnsafe('TRUNCATE credential_projection')
  await db.$executeRaw`DELETE FROM inbox WHERE consumer = ${CREDENTIAL_CONFIG_CONSUMER}`
})
afterAll(async () => {
  await db.$disconnect()
})

// A fixture cfg.auth.credential.v1 payload (Fulfillment's OWN local view,
// mirroring Auth's own credential-config.ts CredentialConfigPayload (Task 4)
// 1:1, C4: never imported from the auth context).
function fixturePayload(overrides: Partial<CredentialConfigPayload> = {}): CredentialConfigPayload {
  return {
    apiId: newId('api'),
    pepperedHash: 'phash-fixture-1',
    vndrId: newId('vndr'),
    workQueue: 'wq-A',
    permissionSetRef: 'vset:vendor_manufacturer',
    mode: 'test',
    status: 'ACTIVE',
    epoch: 1,
    ...overrides,
  }
}

function cfgEnv(payload: CredentialConfigPayload, dedupKey: string, traceId: string): Envelope<CredentialConfigPayload> {
  return newEnvelope({
    type: 'cfg.auth.credential.v1',
    version: 1,
    subject: payload.apiId,
    dedupKey,
    traceId,
    payload,
  })
}

describe('projectCredentialConfig (5c verifier-plane projection from cfg.auth.credential.v1, check 1)', () => {
  it('an ACTIVE cfg event upserts exactly one credential_projection row keyed by api_id, carrying the peppered hash and scope; upserted:true on first delivery', async () => {
    const payload = fixturePayload()
    const env = cfgEnv(payload, stepKey(payload.apiId, 'active', payload.epoch), 'trace-cfg-1')

    const res = await projectCredentialConfig(db, env)
    expect(res.upserted).toBe(true)

    const rows = await db.$queryRaw<
      {
        api_id: string
        peppered_hash: string
        vndr_id: string
        work_queue: string
        permission_set_ref: string
        mode: string
        status: string
        epoch: number
      }[]
    >`SELECT api_id::text AS api_id, peppered_hash, vndr_id::text AS vndr_id, work_queue, permission_set_ref, mode, status, epoch
      FROM credential_projection WHERE api_id = ${toUuid(payload.apiId)}::uuid`

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.api_id).toBe(toUuid(payload.apiId))
    expect(row.peppered_hash).toBe('phash-fixture-1')
    expect(row.vndr_id).toBe(toUuid(payload.vndrId))
    expect(row.work_queue).toBe('wq-A')
    expect(row.permission_set_ref).toBe('vset:vendor_manufacturer')
    expect(row.mode).toBe('test')
    expect(row.status).toBe('ACTIVE')
    expect(row.epoch).toBe(1)
  })

  it('a later REVOKED cfg event (different dedupKey) flips status on the SAME row; a redelivered copy of the ACTIVE event is a no-op (row count and fields unchanged)', async () => {
    const payload = fixturePayload({ apiId: newId('api'), vndrId: newId('vndr'), pepperedHash: 'phash-fixture-2' })
    const activeEnv = cfgEnv(payload, stepKey(payload.apiId, 'active', payload.epoch), 'trace-cfg-2-active')

    const activeRes = await projectCredentialConfig(db, activeEnv)
    expect(activeRes.upserted).toBe(true)

    const revokedPayload: CredentialConfigPayload = { ...payload, status: 'REVOKED' }
    const revokedEnv = cfgEnv(revokedPayload, stepKey(payload.apiId, 'revoked', payload.epoch), 'trace-cfg-2-revoked')
    const revokedRes = await projectCredentialConfig(db, revokedEnv)
    expect(revokedRes.upserted).toBe(true)

    const afterRevoke = await db.$queryRaw<{ status: string }[]>`
      SELECT status FROM credential_projection WHERE api_id = ${toUuid(payload.apiId)}::uuid
    `
    expect(afterRevoke).toHaveLength(1)
    expect(afterRevoke[0]!.status).toBe('REVOKED')

    // redelivery: the SAME active envelope again (same dedupKey) must be a
    // no-op: upserted:false, and the row stays REVOKED (the redelivery does
    // NOT flip it back to ACTIVE).
    const redeliveredRes = await projectCredentialConfig(db, activeEnv)
    expect(redeliveredRes.upserted).toBe(false)

    const rowCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM credential_projection`
    expect(Number(rowCount[0]!.n)).toBe(1)
    const stillRevoked = await db.$queryRaw<{ status: string }[]>`
      SELECT status FROM credential_projection WHERE api_id = ${toUuid(payload.apiId)}::uuid
    `
    expect(stillRevoked[0]!.status).toBe('REVOKED')
  })
})

describe('credentialLookup (the resolve-side lookup closure, 5c/5e)', () => {
  it('resolves a known peppered hash to the CredentialProjectionRow shape with typed wire ids; an unknown hash returns undefined', async () => {
    const payload = fixturePayload({
      apiId: newId('api'),
      vndrId: newId('vndr'),
      pepperedHash: 'phash-fixture-3',
      workQueue: 'wq-lookup',
      permissionSetRef: 'vset:vendor_print',
      mode: 'live',
    })
    const env = cfgEnv(payload, stepKey(payload.apiId, 'active', payload.epoch), 'trace-cfg-lookup')
    await projectCredentialConfig(db, env)

    const lookup = credentialLookup(db)
    const row = await lookup('phash-fixture-3')
    expect(row).toBeDefined()
    expect(row!.apiId).toBe(payload.apiId)
    expect(row!.vndrId).toBe(payload.vndrId)
    expect(row!.workQueue).toBe('wq-lookup')
    expect(row!.permissionSetRef).toBe('vset:vendor_print')
    expect(row!.mode).toBe('live')
    expect(row!.status).toBe('ACTIVE')
    expect(row!.epoch).toBe(1)
    expect(row!.expiresAt).toBeUndefined()

    const unknown = await lookup('phash-does-not-exist')
    expect(unknown).toBeUndefined()
  })
})
