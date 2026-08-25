// Generate postman/collection.json from the edge controllers themselves.
//
// WHY IT PARSES SOURCE RATHER THAN CARRYING A ROUTE TABLE. The previous
// generator (written 2026-08-17, never committed, reconstructed here) held a
// hand-maintained table, which is a second place to forget. This reads the
// controllers, so a route that exists in code but not in the collection is a
// generator bug rather than an oversight, and `--check` can prove the committed
// JSON still matches the code.
//
// THE REPO HAS NO SWAGGER AND NO OPENAPI SPEC, and the body types are plain TS
// `interface` declarations with no class-validator decorators, so nothing about
// the HTTP surface is available at runtime through Nest metadata. Static
// parsing is not a shortcut here; it is the only source of truth.
//
// FIVE FACTS ABOUT THIS CODEBASE THE PARSER LEANS ON (verified 2026-08-20; a
// change to any of them should fail loudly in --check rather than silently drop
// routes):
//   1. Only @Get and @Post are used. No @Put/@Patch/@Delete anywhere.
//   2. Route decorators are single-quoted single-line string literals, or take
//      no argument at all (the four probe routes).
//   3. There is no setGlobalPrefix and no versioning, so the served path is
//      exactly controller base + method path.
//   4. Every @Body() type is an interface declared in the SAME file, an inline
//      object type, or `unknown`. None are imported, none are classes.
//   5. Idempotency-Key is required exactly when the handler declares a
//      @Headers('idempotency-key') param; that is the only way the value is
//      ever obtained, and OpsController.gate() throws without it.
//
// COMMENTS ARE STRIPPED FIRST AND THIS IS LOAD BEARING. The controllers discuss
// their own decorators in prose (`session.controller.ts` mentions @HttpCode,
// `ops.controller.ts:759` says "there is no @Body()", `session.controller.ts`
// carries a commented-out @Controller). Matching decorators against raw text
// invents routes and mis-assigns guards.
//
//   node postman/build-collection.mjs            # write postman/collection.json
//   node postman/build-collection.mjs --check    # exit 1 if the file is stale
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import console from 'node:console'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_PATH = join(REPO_ROOT, 'postman', 'collection.json')

// One base-URL variable per edge, because the edges run on different ports and
// a collection that hardcodes one host is wrong for four of the five. The dev
// ports are the demo harness's (scripts/demo.sh, harness/serve.mjs), not a
// code default: every main.ts is `PORT ?? 3000`.
const EDGES = [
  { app: 'auth-edge', label: 'Auth edge', variable: 'authBase', port: 3000, note: 'Internal operator login, MFA, step-up, session.' },
  { app: 'ops-edge', label: 'Ops edge', variable: 'opsBase', port: 3001, note: 'Operator reads, writes, and reports.' },
  { app: 'vendor-edge', label: 'Vendor edge', variable: 'vendorBase', port: 3002, note: 'Vendor intake, pull, return, courier status. The demo harness serves this on 3002 while vendor-portal defaults to 3010; set the variable to match what you are running.' },
  { app: 'vendor-auth-edge', label: 'Vendor auth edge', variable: 'vendorAuthBase', port: 3011, note: 'Vendor operator login and provisioning.' },
  { app: 'tenant-edge', label: 'Tenant edge', variable: 'tenantBase', port: 3000, note: 'Tenant reads and reports. No dev port is assigned anywhere in the repo; it falls back to PORT ?? 3000, which collides with auth-edge. Set this variable before use.' },
]

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

/**
 * Replace every comment with equivalent-length whitespace, preserving newlines
 * and every byte offset, so reported line numbers stay true. String and
 * template literals are walked through rather than around: a `//` inside a
 * string is not a comment, and `'` inside a comment does not open a string.
 */
export function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }
    if (c === '/' && next === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += '  '
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += c
      i += 1
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '')
          i += 2
          continue
        }
        out += src[i]
        if (src[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** Depth-first walk of apps/<app>/src for *.controller.ts. */
function controllerFiles(app) {
  const root = join(REPO_ROOT, 'apps', app, 'src')
  if (!existsSync(root)) return []
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.endsWith('.controller.ts')) found.push(full)
    }
  }
  walk(root)
  return found
}

/**
 * Split a class body into MEMBERS, where a member is a run of contiguous
 * decorator lines plus the signature that follows. Contiguity is tracked with
 * paren depth, so the one genuinely multi-line decorator in the surface
 * (@UseInterceptors(FileFieldsInterceptor(...)) on the aggregator logo route)
 * stays attached to its own method instead of leaking onto the next.
 */
function members(stripped) {
  const lines = stripped.split('\n')
  const out = []
  let current = null
  let depth = 0
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]
    const trimmed = line.trim()
    const opens = (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length
    if (current === null) {
      if (depth === 0 && trimmed.startsWith('@')) {
        current = { start: idx + 1, decorators: [line], signature: [] }
        depth = opens
      }
      continue
    }
    if (depth > 0) {
      // Still inside a multi-line decorator's argument list.
      current.decorators.push(line)
      depth += opens
      continue
    }
    if (trimmed.startsWith('@')) {
      current.decorators.push(line)
      depth = opens
      continue
    }
    // First non-decorator line: the method signature, which may itself wrap
    // across lines until its parameter list closes.
    current.signature.push(line)
    let sigDepth = opens
    while (sigDepth > 0 && idx + 1 < lines.length) {
      idx += 1
      current.signature.push(lines[idx])
      sigDepth += (lines[idx].match(/\(/g) ?? []).length - (lines[idx].match(/\)/g) ?? []).length
    }
    out.push(current)
    current = null
    depth = 0
  }
  return out
}

/** `interface Name { a: string; b?: number }` -> field list, same file only. */
function interfaces(stripped) {
  const found = new Map()
  const re = /(?:export\s+)?interface\s+(\w+)\s*\{/g
  let m
  while ((m = re.exec(stripped)) !== null) {
    let depth = 1
    let i = re.lastIndex
    while (i < stripped.length && depth > 0) {
      if (stripped[i] === '{') depth += 1
      if (stripped[i] === '}') depth -= 1
      i += 1
    }
    found.set(m[1], parseFields(stripped.slice(re.lastIndex, i - 1)))
  }
  return found
}

function parseFields(body) {
  const fields = []
  // Split on top-level separators only, so a nested object or a union spanning
  // braces does not get chopped in half.
  let depth = 0
  let buf = ''
  const flush = () => {
    const text = buf.trim()
    buf = ''
    if (text === '') return
    const m = /^(\w+)(\?)?\s*:\s*([\s\S]+)$/.exec(text)
    if (m === null) return
    fields.push({ name: m[1], optional: m[2] === '?', type: m[3].trim() })
  }
  for (const ch of body) {
    if (ch === '{' || ch === '(' || ch === '[') depth += 1
    if (ch === '}' || ch === ')' || ch === ']') depth -= 1
    if (depth === 0 && (ch === ';' || ch === '\n')) {
      flush()
      continue
    }
    buf += ch
  }
  flush()
  return fields
}

/** A placeholder that shows the SHAPE without inventing domain semantics. */
function exampleFor(type) {
  const t = type.replace(/\s+/g, ' ').trim()
  if (/\[\]$/.test(t) || /^(readonly )?Array</.test(t)) return []
  // A union of string literals is the one case where a real value is knowable.
  const literals = [...t.matchAll(/'([^']*)'/g)].map((m) => m[1])
  if (literals.length > 0 && /\|/.test(t)) return literals[0]
  if (literals.length === 1 && !/\|/.test(t)) return literals[0]
  if (/^number$/.test(t)) return 0
  if (/^boolean$/.test(t)) return false
  if (/^string$/.test(t)) return ''
  if (t.startsWith('{')) return {}
  if (/^unknown$|^any$/.test(t)) return null
  if (/^Record</.test(t)) return {}
  return ''
}

function bodyExample(typeText, ifaces) {
  if (typeText === undefined) return undefined
  const named = /^(\w+)$/.exec(typeText.trim())
  if (named !== null) {
    const fields = ifaces.get(named[1])
    if (fields === undefined) return undefined
    return {
      example: Object.fromEntries(fields.map((f) => [f.name, exampleFor(f.type)])),
      optional: fields.filter((f) => f.optional).map((f) => f.name),
      typeName: named[1],
    }
  }
  // Inline object type, e.g. `{ handle?: string; totp?: string }`, possibly
  // written as a union with undefined.
  const inline = /\{([\s\S]*)\}/.exec(typeText)
  if (inline !== null) {
    const fields = parseFields(inline[1])
    return {
      example: Object.fromEntries(fields.map((f) => [f.name, exampleFor(f.type)])),
      optional: fields.filter((f) => f.optional).map((f) => f.name),
      typeName: null,
    }
  }
  return undefined
}

/** Parse one controller file into route descriptors, in SOURCE ORDER. */
export function parseController(absPath) {
  const raw = readFileSync(absPath, 'utf8')
  const src = stripComments(raw)
  const baseMatch = /@Controller\(\s*(?:'([^']*)')?\s*\)/.exec(src)
  if (baseMatch === null) return { base: null, routes: [] }
  const base = baseMatch[1] ?? ''
  const classGuards = classLevelGuards(src, baseMatch.index)
  const ifaces = interfaces(src)

  const routes = []
  let decoratorCount = 0
  for (const member of members(src)) {
    const block = member.decorators.join('\n')
    const routeDecorators = [...block.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g)]
    decoratorCount += routeDecorators.length
    if (routeDecorators.length === 0) continue
    const [, verb, pathArg] = routeDecorators[0]
    const signature = member.signature.join('\n')
    const whole = `${block}\n${signature}`

    const methodGuards = [...block.matchAll(/@UseGuards\(([^)]*)\)/g)].flatMap((m) =>
      m[1].split(',').map((g) => g.trim()).filter((g) => g !== ''),
    )
    const guards = [...new Set([...classGuards, ...methodGuards])]
    const readsAuthHeader = /@Headers\(\s*'authorization'\s*\)/i.test(whole)
    // The session routes carry no guard and read no bearer, but they are NOT
    // open: they authenticate against the refresh cookie the login response
    // sets. Calling them "unauthenticated" in the collection would be wrong in
    // the way that costs someone an afternoon.
    const readsCookie = /@Headers\(\s*'cookie'\s*\)/i.test(whole)
    const needsIdempotency = /@Headers\(\s*'idempotency-key'\s*\)/i.test(whole)
    const httpCode = /@HttpCode\((\d+)\)/.exec(block)?.[1]

    const singleFile = /FileInterceptor\(\s*'([^']+)'/.exec(block)?.[1]
    const fieldNames = [...block.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1])
    const multiFields = /FileFieldsInterceptor/.test(block) ? fieldNames : []

    // `@Body() name: Type` - the type runs to the next top-level comma or the
    // end of the parameter list.
    const bodyMatch = /@Body\(\)\s*(\w+)\s*:\s*([^,)]+(?:\{[^}]*\}[^,)]*)?)/.exec(signature)
    const body = bodyExample(bodyMatch?.[2], ifaces)

    const path = [base, pathArg ?? ''].filter((p) => p !== '' && p !== undefined).join('/')
    routes.push({
      verb: verb.toUpperCase(),
      path: `/${path}`,
      line: member.start,
      guards,
      authRequired: guards.length > 0 || readsAuthHeader,
      cookieAuth: readsCookie,
      needsIdempotency,
      httpCode: httpCode === undefined ? undefined : Number(httpCode),
      upload: singleFile !== undefined ? { kind: 'single', field: singleFile } : multiFields.length > 0 ? { kind: 'fields', fields: multiFields } : undefined,
      body,
      handler: /(?:async\s+)?(\w+)\s*\(/.exec(signature)?.[1] ?? '(anonymous)',
    })
  }
  return { base, routes, decoratorCount }
}

// A class-level @UseGuards sits in the decorator run immediately above the
// class declaration, i.e. adjacent to @Controller. Method-level guards are
// found per member; a parser that only reads class decorators would publish
// eight vendor-edge routes and one vendor-auth admin route as public.
function classLevelGuards(src, controllerIndex) {
  const window = src.slice(Math.max(0, controllerIndex - 400), src.indexOf('{', controllerIndex))
  return [...window.matchAll(/@UseGuards\(([^)]*)\)/g)].flatMap((m) =>
    m[1].split(',').map((g) => g.trim()).filter((g) => g !== ''),
  )
}

// ---------------------------------------------------------------------------
// Collection assembly
// ---------------------------------------------------------------------------

function requestFor(edge, controllerName, route) {
  const header = []
  if (route.needsIdempotency) {
    header.push({ key: 'Idempotency-Key', value: '{{$guid}}', description: 'Required. OpsController.gate() rejects a missing or blank value with 400.' })
  }
  if (route.body !== undefined && route.upload === undefined) {
    header.push({ key: 'Content-Type', value: 'application/json' })
  }

  let body
  if (route.upload !== undefined) {
    const fields = route.upload.kind === 'single' ? [route.upload.field] : route.upload.fields
    // A multipart route that ALSO takes text fields must send them as form-data
    // parts, never as a JSON body. Six routes are in that shape and this is the
    // one place a naive generator produces a request the edge cannot parse.
    body = {
      mode: 'formdata',
      formdata: [
        ...fields.map((f) => ({ key: f, type: 'file', src: [] })),
        ...Object.entries(route.body?.example ?? {}).map(([k, v]) => ({
          key: k,
          value: typeof v === 'object' ? JSON.stringify(v) : String(v),
          type: 'text',
        })),
      ],
    }
  } else if (route.body !== undefined) {
    body = { mode: 'raw', raw: JSON.stringify(route.body.example, null, 2), options: { raw: { language: 'json' } } }
  }

  const notes = [`Handler: ${controllerName}.${route.handler} (source order preserved).`]
  if (route.guards.length > 0) notes.push(`Guard: ${route.guards.join(', ')}.`)
  else if (route.authRequired) notes.push('No guard, but the handler reads the Authorization header itself, so a bearer token is required.')
  else if (route.cookieAuth) notes.push('No guard and no bearer: this authenticates against the refresh cookie that POST /session/login sets. Send it with cookies enabled.')
  else notes.push('Unauthenticated.')
  if (route.cookieAuth && route.authRequired) notes.push('Also reads the refresh cookie.')
  if (route.httpCode !== undefined) notes.push(`Success status: ${route.httpCode}.`)
  if (route.body?.typeName != null) notes.push(`Body type: ${route.body.typeName}.`)
  if (route.body !== undefined && route.body.optional.length > 0) {
    notes.push(`Optional fields (send only when meaningful): ${route.body.optional.join(', ')}.`)
  }
  if (route.upload !== undefined) {
    const fields = route.upload.kind === 'single' ? [route.upload.field] : route.upload.fields
    notes.push(`Multipart file field(s): ${fields.join(', ')}.`)
  }
  const params = [...route.path.matchAll(/:(\w+)/g)].map((m) => m[1])
  if (params.length > 0) notes.push(`Path parameters: ${params.join(', ')}.`)

  const rawUrl = `{{${edge.variable}}}${route.path.replace(/:(\w+)/g, ':$1')}`
  return {
    name: `${route.verb} ${route.path}`,
    request: {
      // The collection carries bearer auth at the top level; a public route
      // must opt OUT explicitly or Postman will attach a token the edge then
      // has to reject.
      auth: route.authRequired ? undefined : { type: 'noauth' },
      method: route.verb,
      header,
      ...(body === undefined ? {} : { body }),
      url: {
        raw: rawUrl,
        host: [`{{${edge.variable}}}`],
        path: route.path.split('/').filter((s) => s !== ''),
        variable: params.map((p) => ({ key: p, value: '', description: `Path parameter :${p}` })),
      },
      description: notes.join('\n'),
    },
  }
}

export function build() {
  const folders = []
  const flat = []
  let totalDecorators = 0

  for (const edge of EDGES) {
    const subfolders = []
    for (const file of controllerFiles(edge.app)) {
      const name = file.split('/').pop().replace('.controller.ts', '')
      const { base, routes, decoratorCount } = parseController(file)
      totalDecorators += decoratorCount ?? 0
      if (base === null || routes.length === 0) continue
      subfolders.push({
        name,
        description: `apps/${edge.app}/src/${relative(join(REPO_ROOT, 'apps', edge.app, 'src'), file)} - @Controller('${base}')`,
        item: routes.map((r) => {
          flat.push({ edge: edge.app, controller: name, ...r })
          return requestFor(edge, name, r)
        }),
      })
    }
    if (subfolders.length === 0) continue
    folders.push({ name: edge.label, description: edge.note, item: subfolders })
  }

  const collection = {
    info: {
      name: 'AndPayments Platform',
      description:
        'GENERATED FILE - do not edit by hand.\n\n' +
        'Regenerate with `node postman/build-collection.mjs` whenever an edge HTTP route changes; ' +
        '`node postman/build-collection.mjs --check` fails if this file has drifted from the controllers. ' +
        'Push to the cloud copy with `node postman/sync.mjs --push --yes` (destructive: PUT replaces the whole collection).\n\n' +
        'Set the per-edge base URL variables below to whatever you are running. ' +
        'Set bearerToken from a POST /session/login response (auth edge for operators, vendor auth edge for vendor operators).',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{bearerToken}}', type: 'string' }] },
    variable: [
      ...EDGES.map((e) => ({ key: e.variable, value: `http://localhost:${e.port}`, type: 'string' })),
      { key: 'bearerToken', value: '', type: 'string' },
    ],
    item: folders,
  }
  return { collection, flat, totalDecorators }
}

function main() {
  const check = process.argv.includes('--check')
  const { collection, flat, totalDecorators } = build()

  // ANTI-SILENT-DROP GUARD: every route decorator found in the sources must
  // have produced a request. If these ever disagree, the parser met a form it
  // does not handle and the collection is quietly incomplete.
  if (flat.length !== totalDecorators) {
    console.error(
      `PARSER DROPPED ROUTES: ${totalDecorators} route decorators in the sources, ${flat.length} requests emitted. ` +
        'A decorator form is unhandled; fix the parser before trusting this collection.',
    )
    process.exitCode = 1
    return
  }

  const serialized = `${JSON.stringify(collection, null, 2)}\n`
  const byEdge = new Map()
  for (const r of flat) byEdge.set(r.edge, (byEdge.get(r.edge) ?? 0) + 1)

  if (check) {
    const current = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : ''
    if (current === serialized) {
      console.log(`postman/collection.json is current: ${flat.length} routes across ${byEdge.size} edges.`)
      return
    }
    console.error(
      'postman/collection.json is STALE against the controllers. Run: node postman/build-collection.mjs\n' +
        (current === '' ? '  (the file does not exist yet)' : `  parsed ${flat.length} routes from source`),
    )
    process.exitCode = 1
    return
  }

  const previous = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, 'utf8')) : null
  writeFileSync(OUT_PATH, serialized)
  console.log(`Wrote postman/collection.json: ${flat.length} routes`)
  for (const [edge, n] of [...byEdge].sort()) console.log(`  ${edge.padEnd(18)} ${n}`)

  if (previous !== null) {
    // Drift in BOTH directions against the file we just replaced, so a
    // regeneration says what actually changed rather than only that it ran.
    const keysOf = (c) => {
      const out = new Set()
      const walk = (items) => {
        for (const it of items ?? []) {
          if (Array.isArray(it.item)) walk(it.item)
          else if (it.request !== undefined) out.add(`${it.request.method} ${it.request.url.raw}`)
        }
      }
      walk(c.item)
      return out
    }
    const before = keysOf(previous)
    const after = keysOf(collection)
    const added = [...after].filter((k) => !before.has(k))
    const removed = [...before].filter((k) => !after.has(k))
    if (added.length > 0) console.log(`\nADDED since the last generation (${added.length}):\n  ${added.join('\n  ')}`)
    if (removed.length > 0) console.log(`\nREMOVED since the last generation (${removed.length}):\n  ${removed.join('\n  ')}`)
    if (added.length === 0 && removed.length === 0) console.log('\nNo route added or removed; bodies or headers may still have changed.')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
