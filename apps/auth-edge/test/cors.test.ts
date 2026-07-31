import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { buildTestAuthEdgeApp } from './helpers.js'

// Check 6 (D6, spec 12 task 7): drives the REAL CORS behavior on auth-edge
// (applyPortalCors, wired in app.module.ts) over real HTTP, not just the
// options-builder unit test in packages/edge/test/cors.test.ts. The helper
// wires `portalOrigin: 'https://login.andpay.test'` (test/helpers.ts), so
// that is the one allow-listed origin for every app this file builds.
const ALLOWED_ORIGIN = 'https://login.andpay.test'
const DISALLOWED_ORIGIN = 'https://evil.example'

let app: INestApplication
beforeAll(async () => {
  app = await buildTestAuthEdgeApp()
})
afterAll(async () => {
  await app.close()
})

describe('auth-edge CORS on /session/login (spec 12 task 7/13 check 6)', () => {
  it('an OPTIONS preflight from the configured portal origin is echoed back, credentialed', async () => {
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

  it('a disallowed origin preflight does NOT get its origin reflected', async () => {
    const res = await request(app.getHttpServer())
      .options('/session/login')
      .set('Origin', DISALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
    expect(res.headers['access-control-allow-origin']).not.toBe(DISALLOWED_ORIGIN)
  })

  it('a disallowed origin on a real request does NOT get its origin reflected either', async () => {
    const res = await request(app.getHttpServer())
      .post('/session/login')
      .set('Origin', DISALLOWED_ORIGIN)
      .send({ handle: 'no-such-handle', password: 'whatever' })
    expect(res.headers['access-control-allow-origin']).not.toBe(DISALLOWED_ORIGIN)
  })
})
