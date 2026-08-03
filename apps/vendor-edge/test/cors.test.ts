import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { PrismaClient as FulfillmentClient } from '@andpay/fulfillment-service'
import { buildEdgeApp, type EdgeDeps } from '../src/index.js'

// Check 6 (D6, spec 14a task 15): drives the REAL CORS behavior on
// vendor-edge (applyBearerCors, wired in app.module.ts off
// deps.vendorPortalOrigin), the bearer-only counterpart to
// apps/vendor-auth-edge/test/cors.test.ts. This edge never sets or reads a
// cookie (its only credential transport is the Authorization header), so its
// CORS must allow-list the SAME vendor-portal origin WITHOUT credentials:
// Access-Control-Allow-Credentials must be ABSENT here, unlike the
// vendor-auth-edge cookie path.
const PEPPER = 'dev-pepper-not-a-real-secret'
const ALLOWED_ORIGIN = 'https://vendor.andpay.test'
const DISALLOWED_ORIGIN = 'https://evil.example'

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })

let app: INestApplication
beforeAll(async () => {
  const deps: EdgeDeps = { fulfillmentDb, pepper: PEPPER, expectedMode: 'test', vendorPortalOrigin: ALLOWED_ORIGIN }
  app = await buildEdgeApp(deps)
  await app.init()
})
afterAll(async () => {
  await app.close()
  await fulfillmentDb.$disconnect()
})

describe('vendor-edge CORS on /vendor/courier/status (spec 14a task 15, check 6)', () => {
  it('an OPTIONS preflight from the configured vendor-portal origin is echoed back, NOT credentialed', async () => {
    const res = await request(app.getHttpServer())
      .options('/vendor/courier/status')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    // Bearer-only: no cookie is ever set or read on this edge, so
    // Access-Control-Allow-Credentials must be ABSENT (never 'true'),
    // distinguishing it from vendor-auth-edge's credentialed cookie path.
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('a disallowed origin preflight does NOT get its origin reflected', async () => {
    const res = await request(app.getHttpServer())
      .options('/vendor/courier/status')
      .set('Origin', DISALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
    expect(res.headers['access-control-allow-origin']).not.toBe(DISALLOWED_ORIGIN)
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('the ops-portal origin (a different, distinct audience) is also rejected: no allow-origin echoed', async () => {
    const res = await request(app.getHttpServer())
      .options('/vendor/courier/status')
      .set('Origin', 'https://ops.andpay.test')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
    expect(res.headers['access-control-allow-origin']).not.toBe('https://ops.andpay.test')
  })
})
