import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { buildTestVendorAuthEdgeApp } from './helpers.js'

let app: INestApplication
beforeAll(async () => {
  app = await buildTestVendorAuthEdgeApp()
})
afterAll(async () => {
  await app.close()
})

describe('vendor-auth-edge scaffold (spec 14a task 8)', () => {
  it('the probe returns 200 and the app builds (multi-key signer token-DI)', async () => {
    const res = await request(app.getHttpServer()).get('/probe')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })
})
