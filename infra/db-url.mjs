// Sole owner of turning the four .env primitives into connection URLs.
//
// TWO BEHAVIOURS ARE LOAD BEARING, both learned from the live instance on
// 2026-08-17.
//
// 1. This parses .env LITERALLY and never shell-sources it. Passwords
//    legitimately contain spaces, '#', '$' and quotes. A `. ./.env` executes
//    them: that is how a fragment of a live password reached a terminal
//    transcript.
// 2. The password is PERCENT-ENCODED before it enters the URL. A raw '#'
//    begins a URL fragment and silently truncates the connection string, so
//    the failure is a confusing connect error rather than a parse error.
//
// This file is deliberately dependency-free and plain ESM so that bash, the
// gitignored demo harness, and the typed test suite can all use one
// implementation. Types live alongside in db-url.d.mts.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CONTEXTS = ['identity', 'tms', 'fulfillment', 'orchestrator', 'auth', 'analytics']

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function parseEnvFile(text) {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    // The value is NOT trimmed: trailing whitespace can be part of a password.
    let value = line.slice(eq + 1)
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

// encodeURIComponent leaves !'()* unescaped. They are legal in a URL userinfo
// field, but a surviving quote would break the `export NAME='value'` lines the
// CLI emits, so the RFC 3986 unreserved set is enforced instead.
export function encodeUserinfo(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

function credentials(env) {
  const missing = []
  if (!env.ANDPAY_DB_HOST) missing.push('ANDPAY_DB_HOST')
  if (!env.ANDPAY_DB_USER) missing.push('ANDPAY_DB_USER')
  if (!env.ANDPAY_DB_PASSWORD) missing.push('ANDPAY_DB_PASSWORD')
  if (missing.length > 0) {
    throw new Error(
      `.env is missing required keys: ${missing.join(', ')}. ` +
        'See .env.example for the shape. Never commit the file.',
    )
  }
  return {
    host: env.ANDPAY_DB_HOST,
    port: env.ANDPAY_DB_PORT || '5432',
    database: env.ANDPAY_DB_NAME || 'andpay',
    auth: `${encodeUserinfo(env.ANDPAY_DB_USER)}:${encodeUserinfo(env.ANDPAY_DB_PASSWORD)}`,
  }
}

export function deriveUrls(env) {
  const { host, port, database, auth } = credentials(env)
  const out = {}
  for (const ctx of CONTEXTS) {
    out[`${ctx.toUpperCase()}_DATABASE_URL`] =
      `postgresql://${auth}@${host}:${port}/${database}?schema=${ctx}&sslmode=require`
  }
  return out
}

// The maintenance database, used ONLY to CREATE DATABASE during bootstrap.
export function deriveAdminUrl(env) {
  const { host, port, auth } = credentials(env)
  return `postgresql://${auth}@${host}:${port}/postgres?sslmode=require`
}

export function loadEnvFile(path = join(REPO_ROOT, '.env')) {
  if (!existsSync(path)) {
    throw new Error(`no .env at ${path}. Copy the shared-RDS block from .env.example and fill it in.`)
  }
  return parseEnvFile(readFileSync(path, 'utf8'))
}

// CLI mode: emit shell export lines for infra/rds-env.sh to eval. Values are
// percent-encoded above, so no quote can survive to break the single quoting.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = loadEnvFile()
  const lines = Object.entries(deriveUrls(env)).map(([k, v]) => `export ${k}='${v}'`)
  lines.push(`export ANDPAY_ADMIN_DATABASE_URL='${deriveAdminUrl(env)}'`)
  console.log(lines.join('\n'))
}
