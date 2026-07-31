import 'reflect-metadata'
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { buildTestAuthEdgeApp } from './helpers.js'
import { InMemoryTokenBucket } from '../src/throttle.js'

describe('6d source throttle (spec 12 task 12)', () => {
  it('a burst from one source hits 429 after the bucket drains', async () => {
    const app = await buildTestAuthEdgeApp({ throttle: new InMemoryTokenBucket({ capacity: 3, refillPerSec: 0 }) })
    const hits: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await request(app.getHttpServer()).post('/session/login').set('X-Forwarded-For', '203.0.113.7').send({ handle: 'x', password: 'y' })
      hits.push(res.status)
    }
    expect(hits.filter((s) => s === 429).length).toBeGreaterThan(0)
    await app.close()
  })

  it('a different source is NOT locked out by the first source burst (source-not-credential keying)', async () => {
    const app = await buildTestAuthEdgeApp({ throttle: new InMemoryTokenBucket({ capacity: 2, refillPerSec: 0 }) })
    for (let i = 0; i < 5; i++) await request(app.getHttpServer()).post('/session/login').set('X-Forwarded-For', '203.0.113.7').send({ handle: 'victim', password: 'y' })
    const victim = await request(app.getHttpServer()).post('/session/login').set('X-Forwarded-For', '198.51.100.9').send({ handle: 'victim', password: 'y' })
    expect(victim.status).not.toBe(429)
    await app.close()
  })

  it('fails OPEN: a throttle whose take() throws lets the login proceed', async () => {
    const throwing = { take: async () => { throw new Error('store down') } }
    const app = await buildTestAuthEdgeApp({ throttle: throwing })
    const res = await request(app.getHttpServer()).post('/session/login').set('X-Forwarded-For', '203.0.113.7').send({ handle: 'x', password: 'y' })
    expect(res.status).not.toBe(429) // 401 (bad creds) or 200, never a throttle block
    await app.close()
  })
})
