import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { buildTestVendorAuthEdgeApp } from './helpers.js'

// Check 6 (D6, spec 14a task 15): drives the REAL CORS behavior on
// vendor-auth-edge (applyPortalCors, wired in app.module.ts off
// deps.vendorPortalOrigin) over real HTTP, mirroring
// apps/auth-edge/test/cors.test.ts's shape exactly. The test helper wires
// vendorPortalOrigin: 'https://vendor.andpay.test' by default (test/helpers.ts),
// so that is the one allow-listed origin for the app this file builds. The
// disallowed-origin case is deliberately the OPS-PORTAL origin, not an
// arbitrary third party: the vendor plane and the internal ops plane are
// distinct audiences (D6) and neither portal's browser origin may ride the
// other edge's cookie.
const ALLOWED_ORIGIN = 'https://vendor.andpay.test'
const OPS_PORTAL_ORIGIN = 'https://ops.andpay.test'
const DISALLOWED_ORIGIN = 'https://evil.example'

let app: INestApplication
beforeAll(async () => {
  app = await buildTestVendorAuthEdgeApp()
})
afterAll(async () => {
  await app.close()
})

describe('vendor-auth-edge CORS on /session/login (spec 14a task 15, check 6)', () => {
  it('an OPTIONS preflight from the configured vendor-portal origin is echoed back, credentialed', async () => {
    const res = await request(app.getHttpServer())
      .options('/session/login')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('a real request carrying the configured Origin header gets the same allow-origin/credentials pair', async () => {
    const res = await request(app.getHttpServer())
      .post('/session/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ handle: 'no-such-handle', password: 'whatever' })
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('the ops-portal origin (a DIFFERENT, distinct audience, D6) is REJECTED: no allow-origin echoed on preflight', async () => {
    const res = await request(app.getHttpServer())
      .options('/session/login')
      .set('Origin', OPS_PORTAL_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
    expect(res.headers['access-control-allow-origin']).not.toBe(OPS_PORTAL_ORIGIN)
  })

  it('the ops-portal origin is REJECTED on a real request too: no allow-origin echoed', async () => {
    const res = await request(app.getHttpServer())
      .post('/session/login')
      .set('Origin', OPS_PORTAL_ORIGIN)
      .send({ handle: 'no-such-handle', password: 'whatever' })
    expect(res.headers['access-control-allow-origin']).not.toBe(OPS_PORTAL_ORIGIN)
  })

  it('an arbitrary disallowed origin preflight does NOT get its origin reflected', async () => {
    const res = await request(app.getHttpServer())
      .options('/session/login')
      .set('Origin', DISALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
    expect(res.headers['access-control-allow-origin']).not.toBe(DISALLOWED_ORIGIN)
  })

  it('an arbitrary disallowed origin on a real request does NOT get its origin reflected either', async () => {
    const res = await request(app.getHttpServer())
      .post('/session/login')
      .set('Origin', DISALLOWED_ORIGIN)
      .send({ handle: 'no-such-handle', password: 'whatever' })
    expect(res.headers['access-control-allow-origin']).not.toBe(DISALLOWED_ORIGIN)
  })
})

// The credentials-only-on-the-cookie-path half of check 6 (vendor-edge is
// bearer-only and must NEVER be credentialed) is proven in
// apps/vendor-edge/test/cors.test.ts, against the REAL vendor-edge app
// (applyBearerCors, wired off deps.vendorPortalOrigin in that app's own
// app.module.ts). Not duplicated here: vendor-auth-edge and vendor-edge are
// separate deployable processes with separate package.json dependency
// graphs (vendor-auth-edge does not depend on @andpay/vendor-edge), so the
// two proofs live next to the app each one actually asserts against.
