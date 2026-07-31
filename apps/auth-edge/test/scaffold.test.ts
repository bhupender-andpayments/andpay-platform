import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { buildTestAuthEdgeApp } from './helpers.js'

let app: INestApplication
beforeAll(async () => {
  app = await buildTestAuthEdgeApp()
})
afterAll(async () => {
  await app.close()
})

describe('auth-edge scaffold (spec 12 task 8)', () => {
  it('the probe returns 200 and the app builds', async () => {
    const res = await request(app.getHttpServer()).get('/probe')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })
})
