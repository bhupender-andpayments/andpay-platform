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

// Host is placed in the URL authority, never percent-encoded (encoding a
// hostname breaks resolution: the dots would survive but an encoded
// character would not resolve), so it is validated to a charset instead. That
// charset excludes quotes and every other shell metacharacter, which is what
// keeps the CLI's export lines safe below.
const DNS_HOST_CHAR = /[A-Za-z0-9.-]/
const IPV6_LITERAL_CHAR = /[0-9a-fA-F:]/

function validateHost(value) {
  const bracketed = value.startsWith('[') && value.endsWith(']') && value.length >= 3
  const inner = bracketed ? value.slice(1, -1) : value
  const allowed = bracketed ? IPV6_LITERAL_CHAR : DNS_HOST_CHAR
  if (inner.length === 0) {
    throw new Error('ANDPAY_DB_HOST is empty inside its brackets.')
  }
  for (let i = 0; i < inner.length; i++) {
    if (!allowed.test(inner[i])) {
      throw new Error(
        `ANDPAY_DB_HOST has an invalid character at index ${bracketed ? i + 1 : i}. ` +
          'Only letters, digits, "." and "-" are allowed, or an IPv6 literal in brackets ' +
          '(hex digits and ":").',
      )
    }
  }
  return value
}

// Port is placed unencoded too; it is validated to digits only rather than
// percent-encoded, for the same reason as host.
function validatePort(value) {
  if (value.length === 0) {
    throw new Error('ANDPAY_DB_PORT is empty.')
  }
  for (let i = 0; i < value.length; i++) {
    if (value[i] < '0' || value[i] > '9') {
      throw new Error(`ANDPAY_DB_PORT has a non-digit character at index ${i}.`)
    }
  }
  return value
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
    host: validateHost(env.ANDPAY_DB_HOST),
    port: validatePort(env.ANDPAY_DB_PORT || '5432'),
    // Database sits in a URL path segment, where percent-encoding is valid
    // and round-trips correctly, unlike host or port.
    database: encodeUserinfo(env.ANDPAY_DB_NAME || 'andpay'),
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

// CLI mode: emit shell export lines for infra/rds-env.sh to eval. User,
// password and database are percent-encoded above; host and port are instead
// validated against a charset that excludes quotes and every other shell
// metacharacter. Either way, by the time a value reaches this line it cannot
// contain a quote, so the single quoting below cannot be broken.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = loadEnvFile()
  const lines = Object.entries(deriveUrls(env)).map(([k, v]) => `export ${k}='${v}'`)
  lines.push(`export ANDPAY_ADMIN_DATABASE_URL='${deriveAdminUrl(env)}'`)
  console.log(lines.join('\n'))
}
