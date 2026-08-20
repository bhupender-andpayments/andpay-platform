import { describe, it, expect } from 'vitest'
import { stripComments, build } from '../postman/build-collection.mjs'
import { flattenRequests, diffCollections } from '../postman/sync.mjs'

// The Postman generator parses the edge controllers as TEXT, because the body
// types are plain TS interfaces with no class-validator decorators and the repo
// carries no OpenAPI spec, so nothing about the HTTP surface exists at runtime.
// These tests pin the parser behaviours a silent failure would ride in on.
//
// This suite deliberately does NOT assert that postman/collection.json is
// current: that check is `node postman/build-collection.mjs --check`, kept out
// of the gate on purpose so a route change does not fail an unrelated test run.

describe('comment stripping, which the whole parser rests on', () => {
  // The controllers discuss their own decorators in prose: session.controller.ts
  // mentions @HttpCode, ops.controller.ts says "there is no @Body()", and one
  // file carries a commented-out @Controller. Matching against raw text invents
  // routes and mis-assigns guards.
  it('removes a decorator that appears inside a line comment', () => {
    expect(stripComments("// @Get('ghost')\nreal")).not.toContain('@Get')
  })

  it('removes a decorator inside a block comment', () => {
    expect(stripComments("/* @Post('ghost') */ real")).not.toContain('@Post')
  })

  it('preserves byte offsets and line numbers so reported lines stay true', () => {
    const src = "a // xx\nb /* yy */ c\n"
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    expect(out.split('\n').length).toBe(src.split('\n').length)
    expect(out.startsWith('a ')).toBe(true)
  })

  it('does not treat // inside a string literal as a comment', () => {
    expect(stripComments("const u = 'http://x/y' // note")).toContain("'http://x/y'")
  })

  it('does not let a quote inside a comment open a string', () => {
    // A naive scanner sees the apostrophe in "don't", enters string mode, and
    // swallows the rest of the file, dropping every route after this line.
    const out = stripComments("// don't do this\n@Get('kept')\n")
    expect(out).toContain("@Get('kept')")
  })
})

describe('the generated collection, built from the live controllers', () => {
  const { collection, flat, totalDecorators } = build()

  // THE ANTI-SILENT-DROP GUARD. Every route decorator found in the sources must
  // have produced a request. If a controller adopts a decorator form the parser
  // does not handle (a template literal, a multi-line route decorator, @Put),
  // this fails instead of quietly shipping a short collection.
  it('emits exactly one request per route decorator in the sources', () => {
    expect(flat.length).toBe(totalDecorators)
  })

  it('covers all five edges and finds the whole surface', () => {
    expect(collection.item.map((f: { name: string }) => f.name)).toEqual([
      'Auth edge',
      'Ops edge',
      'Vendor edge',
      'Vendor auth edge',
      'Tenant edge',
    ])
    // A floor, not an equality: routes get added, and a test that has to be
    // edited for every new route teaches people to edit tests thoughtlessly.
    // The per-decorator assertion above is what actually pins completeness.
    expect(flat.length).toBeGreaterThanOrEqual(109)
  })

  it('composes the path from the controller base with no global prefix', () => {
    // There is no setGlobalPrefix anywhere in the repo, so /ops comes only from
    // @Controller('ops'). The probes prove the asymmetry: ops-edge prefixes its
    // domain routes but serves its probe at the bare path.
    const paths = flat.map((r) => r.path)
    expect(paths).toContain('/ops/bank-masters')
    expect(paths).toContain('/probe')
    expect(paths).not.toContain('/ops/probe')
  })

  it('requires Idempotency-Key exactly where the handler declares the header param', () => {
    const withKey = flat.filter((r) => r.needsIdempotency)
    // Every one is a POST on the ops edge; no other edge uses the header.
    expect(withKey.every((r) => r.verb === 'POST' && r.path.startsWith('/ops'))).toBe(true)
    // The four persist-nothing previews are exempt by design (they call
    // authorizePreview, not gate), so they must NOT carry the header.
    const previews = flat.filter((r) => r.path.endsWith('/preview'))
    expect(previews.length).toBeGreaterThan(0)
    expect(previews.some((r) => r.needsIdempotency)).toBe(false)
  })

  it('reads a method-level guard, not only a class-level one', () => {
    // vendor-edge has NO class-level guard: all eight routes are guarded per
    // method. A parser that only read class decorators would publish them as
    // public, which is the worst possible error in this file.
    const vendor = flat.filter((r) => r.edge === 'vendor-edge')
    expect(vendor.length).toBeGreaterThan(0)
    expect(vendor.every((r) => r.authRequired)).toBe(true)
  })

  it('marks the cookie-authenticated session routes as neither open nor bearer', () => {
    const logout = flat.find((r) => r.path === '/session/logout' && r.edge === 'auth-edge')
    expect(logout?.cookieAuth).toBe(true)
    expect(logout?.authRequired).toBe(false)
  })

  it('keeps both file fields of the one multi-line FileFieldsInterceptor route', () => {
    // @UseInterceptors(FileFieldsInterceptor([...])) spans nine lines on the
    // aggregator logo route; a line-oriented parser drops the field names or
    // attributes them to the next method.
    const logo = flat.find((r) => r.path === '/ops/aggregators/:aggrId/logo')
    expect(logo?.upload).toEqual({ kind: 'fields', fields: ['master', 'derivative'] })
  })

  it('sends a multipart route that also takes text fields as form-data, never JSON', () => {
    const upload = flat.find((r) => r.path === '/ops/uploads/device-inventory')
    expect(upload?.upload?.kind).toBe('single')
    expect(upload?.body).not.toBeUndefined()
    const req = flattenRequests(collection.item).find((r) => r.url.endsWith('/ops/uploads/device-inventory'))
    expect(req?.hasBody).toBe(true)
  })

  it('derives a body example from the interface declared in the same file', () => {
    const create = flat.find((r) => r.path === '/ops/bank-masters' && r.verb === 'POST')
    expect(create?.body?.typeName).toBe('BankMasterCreateBody')
    expect(Object.keys(create?.body?.example ?? {})).toContain('bankReferenceCode')
    expect(create?.body?.optional).toContain('address2')
  })

  it('opts public routes out of the collection-level bearer auth', () => {
    const login = flattenRequests(collection.item).find((r) => r.url.endsWith('/session/login'))
    expect(login).not.toBeUndefined()
    const item = JSON.stringify(collection)
    expect(item).toContain('"noauth"')
  })
})

describe('the cloud diff', () => {
  const local = [
    { key: 'GET {{opsBase}}/ops/a', folder: 'Ops', headers: [], hasBody: false },
    { key: 'POST {{opsBase}}/ops/b', folder: 'Ops', headers: ['Idempotency-Key'], hasBody: true },
  ]

  it('reports drift in both directions, not just what the code adds', () => {
    const cloud = [
      { key: 'GET {{opsBase}}/ops/a', folder: 'Ops', headers: [], hasBody: false },
      { key: 'GET {{opsBase}}/ops/handmade', folder: 'Ops', headers: [], hasBody: false },
    ]
    const d = diffCollections(local, cloud)
    expect(d.missingInCloud.map((r) => r.key)).toEqual(['POST {{opsBase}}/ops/b'])
    // Anything the cloud holds and the code does not is what a push DELETES,
    // so it has to be named before the destructive step, never after.
    expect(d.notInCode.map((r) => r.key)).toEqual(['GET {{opsBase}}/ops/handmade'])
  })

  it('flags a same-route request whose headers or body changed', () => {
    const cloud = [{ key: 'POST {{opsBase}}/ops/b', folder: 'Ops', headers: [], hasBody: false }]
    const d = diffCollections([local[1]!], cloud)
    expect(d.changed).toHaveLength(1)
    expect(d.changed[0]!.deltas.join(' ')).toContain('Idempotency-Key')
  })

  it('is silent when the two agree', () => {
    const d = diffCollections(local, local)
    expect(d.missingInCloud).toHaveLength(0)
    expect(d.notInCode).toHaveLength(0)
    expect(d.changed).toHaveLength(0)
  })
})
