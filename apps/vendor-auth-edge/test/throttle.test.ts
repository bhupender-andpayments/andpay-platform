import 'reflect-metadata'
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { buildTestVendorAuthEdgeApp } from './helpers.js'
import { InMemoryTokenBucket } from '../src/throttle.js'

// 6d source-throttle proofs (spec 14a task 15, check 7). The source-burst
// 429 and the fail-open-on-store-error behavior are ALREADY proven in
// login.test.ts (task 9, 'a burst from one source hits a real 429 after the
// bucket drains' and 'fails OPEN: a throttle whose take() throws lets the
// login proceed to the normal auth check'). This file adds the ONE property
// task 9 did not cover: the victim-not-locked negative. sourceKey (request.ts)
// keys the bucket ONLY on the request source (X-Forwarded-For first hop,
// else the socket peer), NEVER on the handle/credential (throttle.ts's own
// doc comment), so there is NO per-principal hard lockout anywhere on this
// edge: a third party cannot lock a victim vendor operator out of their own
// account merely by failing that victim's handle from one source.
describe('6d victim-not-locked (source-not-credential keying, spec 14a task 15 check 7)', () => {
  it('a third party bursting failed logins against a victim handle from ONE source does not stop the SAME victim handle from a DIFFERENT source', async () => {
    // A tight bucket (capacity 2, no refill) so the attacker's source drains
    // to 429 fast and stays there for the rest of the test.
    const app = await buildTestVendorAuthEdgeApp({ throttle: new InMemoryTokenBucket({ capacity: 2, refillPerSec: 0 }) })
    const attackerSource = '203.0.113.66'
    const victimHandle = 'victim-operator'

    // The attacker bursts the victim's handle from ONE source until it 429s.
    const attackerHits: number[] = []
    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer())
        .post('/session/login')
        .set('X-Forwarded-For', attackerSource)
        .send({ handle: victimHandle, password: 'guess-1' })
      attackerHits.push(res.status)
    }
    expect(attackerHits).toContain(429)

    // The attacker's OWN source stays throttled: the bucket never recovers
    // (refillPerSec: 0), so a further attempt from that same source still
    // 429s. This is the control condition proving the throttle is actually
    // engaged before the victim assertion below is meaningful.
    const stillThrottled = await request(app.getHttpServer())
      .post('/session/login')
      .set('X-Forwarded-For', attackerSource)
      .send({ handle: victimHandle, password: 'guess-2' })
    expect(stillThrottled.status).toBe(429)

    // The SAME victim handle, presented from a DIFFERENT source, is NEVER
    // 429'd by the attacker's burst: the bucket is keyed per-source, not
    // per-handle, so there is no shared budget between the two callers. A
    // wrong password from the victim's own source still 401s (uniform
    // failure), never 429 (there is no per-principal lockout to trip).
    const victimFromOwnSource = await request(app.getHttpServer())
      .post('/session/login')
      .set('X-Forwarded-For', '198.51.100.42')
      .send({ handle: victimHandle, password: 'also-wrong' })
    expect(victimFromOwnSource.status).not.toBe(429)
    expect(victimFromOwnSource.status).toBe(401)

    await app.close()
  })
})
