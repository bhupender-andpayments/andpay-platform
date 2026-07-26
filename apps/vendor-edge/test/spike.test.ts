import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { SpikeModule } from '../src/spike.module.js'

let app: INestApplication

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [SpikeModule] }).compile()
  app = mod.createNestApplication()
  await app.init()
})

afterAll(async () => {
  await app.close()
})

describe('nestjs esm + vitest viability spike', () => {
  it('DI + guard + JSON body round-trip', async () => {
    const res = await request(app.getHttpServer())
      .post('/spike/echo')
      .set('Authorization', 'Bearer ok-123')
      .send({ name: 'vndr' })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ greeting: 'hello', name: 'vndr' })
  })

  it('guard denies without the header (403)', async () => {
    const res = await request(app.getHttpServer()).post('/spike/echo').send({ name: 'x' })
    expect(res.status).toBe(403)
  })

  it('multipart file upload parses JSON', async () => {
    const res = await request(app.getHttpServer())
      .post('/spike/upload')
      .set('Authorization', 'Bearer ok-1')
      .attach('file', Buffer.from(JSON.stringify({ rows: [1, 2] }), 'utf8'), 'sheet.json')
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ parsed: { rows: [1, 2] } })
  })
})
