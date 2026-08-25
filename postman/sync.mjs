// Diff (and, only when told twice, overwrite) Rahul's CLOUD Postman collection
// against the generated local one.
//
// SPLIT OF RESPONSIBILITY. build-collection.mjs is the generator: it parses the
// edge controllers and writes postman/collection.json. This script never looks
// at a controller. It compares that committed JSON against what the Postman
// cloud holds, so "the collection drifted from the code" and "the cloud drifted
// from the collection" stay two separately diagnosable failures.
//
// THE API KEY IS READ FROM THE ENVIRONMENT AND NOWHERE ELSE. Never accept it as
// an argv flag: argv lands in shell history and in the process list, which is
// how a key leaks. Rahul exports POSTMAN_API_KEY himself.
//
// A PUSH IS DESTRUCTIVE. The Postman API has no merge; PUT replaces the whole
// collection and discards anything added by hand in the Postman UI. Hence two
// gates (--push AND --yes) and a printed diff first.
//
//   node postman/sync.mjs                 # diff only, read only
//   node postman/sync.mjs --push --yes    # overwrite the cloud copy
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import console from 'node:console'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const COLLECTION_PATH = join(REPO_ROOT, 'postman', 'collection.json')

// Rahul's collection, recorded 2026-08-17. The workspace id is not needed for
// a GET or a PUT by uid; it is kept here because the browser URL needs it and
// this is the only place that pairing is written down.
export const COLLECTION_UID = '57176441-81eb49db-eb0a-4c0b-9947-c96d62ffa6ac'
export const WORKSPACE_ID = 'c410e7be-2efc-4457-87e1-2527865bbcf8'

const API = 'https://api.getpostman.com'

/**
 * Every request in a collection, flattened out of the folder tree, keyed the
 * way a human compares two APIs: "METHOD /path". Postman nests arbitrarily
 * deep, so this recurses rather than assuming one folder level.
 */
export function flattenRequests(item, trail = []) {
  const out = []
  for (const node of item ?? []) {
    if (Array.isArray(node.item)) {
      out.push(...flattenRequests(node.item, [...trail, node.name]))
      continue
    }
    if (node.request === undefined) continue
    const req = node.request
    const raw = typeof req.url === 'string' ? req.url : (req.url?.raw ?? '')
    out.push({
      folder: trail.join(' / '),
      name: node.name,
      method: req.method ?? 'GET',
      // The variable prefix ({{opsBase}}) is part of the identity: the same
      // path on two different edges is two different routes.
      url: raw,
      key: `${req.method ?? 'GET'} ${raw}`,
      headers: (req.header ?? []).map((h) => h.key).sort(),
      hasBody: req.body?.raw !== undefined || req.body?.formdata !== undefined,
    })
  }
  return out
}

/** Added, removed, and changed, computed in BOTH directions (never one). */
export function diffCollections(localReqs, cloudReqs) {
  const byKey = (list) => new Map(list.map((r) => [r.key, r]))
  const l = byKey(localReqs)
  const c = byKey(cloudReqs)
  const missingInCloud = [...l.values()].filter((r) => !c.has(r.key))
  const notInCode = [...c.values()].filter((r) => !l.has(r.key))
  const changed = []
  for (const [key, lr] of l) {
    const cr = c.get(key)
    if (cr === undefined) continue
    const deltas = []
    if (lr.folder !== cr.folder) deltas.push(`folder ${cr.folder || '(root)'} -> ${lr.folder}`)
    if (lr.hasBody !== cr.hasBody) deltas.push(lr.hasBody ? 'gained a body' : 'lost its body')
    const lh = lr.headers.join(',')
    const ch = cr.headers.join(',')
    if (lh !== ch) deltas.push(`headers [${ch}] -> [${lh}]`)
    if (deltas.length > 0) changed.push({ key, deltas })
  }
  return { missingInCloud, notInCode, changed }
}

async function api(path, init = {}) {
  const key = process.env.POSTMAN_API_KEY
  if (key === undefined || key === '') {
    throw new Error(
      'POSTMAN_API_KEY is not set. Export it in your shell (never pass it as an argument, it would land in shell history) and re-run.',
    )
  }
  const res = await globalThis.fetch(`${API}${path}`, {
    ...init,
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  if (!res.ok) {
    // The body carries Postman's own reason (bad key, unknown uid, rate limit).
    // Truncated because an HTML error page would otherwise flood the terminal.
    throw new Error(`Postman API ${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 400)}`)
  }
  return JSON.parse(text)
}

function report({ missingInCloud, notInCode, changed }) {
  if (missingInCloud.length === 0 && notInCode.length === 0 && changed.length === 0) {
    console.log('The cloud collection matches postman/collection.json. Nothing to push.')
    return false
  }
  if (missingInCloud.length > 0) {
    console.log(`\nIN THE CODE, MISSING FROM THE CLOUD (${missingInCloud.length}):`)
    for (const r of missingInCloud) console.log(`  + ${r.method.padEnd(6)} ${r.url}   [${r.folder}]`)
  }
  if (notInCode.length > 0) {
    console.log(`\nIN THE CLOUD, NOT IN THE CODE (${notInCode.length}) - a push DELETES these:`)
    for (const r of notInCode) console.log(`  - ${r.method.padEnd(6)} ${r.url}   [${r.folder}]`)
  }
  if (changed.length > 0) {
    console.log(`\nSAME ROUTE, DIFFERENT REQUEST (${changed.length}):`)
    for (const r of changed) console.log(`  ~ ${r.key}\n      ${r.deltas.join('\n      ')}`)
  }
  return true
}

async function main() {
  const argv = process.argv.slice(2)
  const push = argv.includes('--push')
  const yes = argv.includes('--yes')

  let local
  try {
    local = JSON.parse(readFileSync(COLLECTION_PATH, 'utf8'))
  } catch {
    throw new Error(`no generated collection at ${COLLECTION_PATH}. Run: node postman/build-collection.mjs`)
  }

  const cloud = await api(`/collections/${COLLECTION_UID}`)
  const localReqs = flattenRequests(local.item)
  const cloudReqs = flattenRequests(cloud.collection?.item)
  console.log(`local: ${localReqs.length} requests   cloud: ${cloudReqs.length} requests`)

  const drift = report(diffCollections(localReqs, cloudReqs))

  if (!push) {
    if (drift) console.log('\nRead-only run. To overwrite the cloud copy: node postman/sync.mjs --push --yes')
    return
  }
  if (!yes) {
    console.log(
      '\nREFUSING TO PUSH without --yes. A push REPLACES the whole cloud collection;\n' +
        'anything added by hand in the Postman UI (the "not in the code" list above) is lost.',
    )
    process.exitCode = 1
    return
  }
  // Postman rejects a PUT whose body carries a stale `info._postman_id` from
  // another collection, so the cloud copy's own info block is preserved and
  // only the items and variables are replaced.
  const body = {
    collection: {
      info: { ...cloud.collection.info, name: local.info.name, description: local.info.description },
      item: local.item,
      variable: local.variable,
      auth: local.auth,
    },
  }
  await api(`/collections/${COLLECTION_UID}`, { method: 'PUT', body: JSON.stringify(body) })
  console.log(`\nPushed ${localReqs.length} requests to the cloud collection.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(String(err.message ?? err))
    process.exitCode = 1
  })
}
