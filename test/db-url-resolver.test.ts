import { describe, it, expect } from 'vitest'
import { parseEnvFile, deriveUrls, deriveAdminUrl, encodeUserinfo } from '../infra/db-url.mjs'

// The real master password contained a space and a '#'. Shell-sourcing the
// file executed part of it as a command, which is how a fragment of a live
// credential reached a terminal transcript on 2026-08-17. These cases pin the
// two behaviours that prevent a repeat.
describe('.env parsing, which is literal and never shell-sourced', () => {
  it('keeps a value containing a space and a hash intact', () => {
    expect(parseEnvFile('ANDPAY_DB_PASSWORD=aB cd#efg\n').ANDPAY_DB_PASSWORD).toBe('aB cd#efg')
  })

  it('skips a whole-line comment but never treats an inline hash as one', () => {
    const env = parseEnvFile('# a comment\nK=v#notacomment\n')
    expect(env.K).toBe('v#notacomment')
    expect(env['# a comment']).toBeUndefined()
  })

  it('strips one layer of matched quotes and keeps quotes inside the value', () => {
    expect(parseEnvFile('K="a\'b"\n').K).toBe("a'b")
    expect(parseEnvFile('K=plain\n').K).toBe('plain')
  })

  it('keeps a value containing an equals sign', () => {
    expect(parseEnvFile('K=a=b=c\n').K).toBe('a=b=c')
  })

  it('tolerates CRLF line endings', () => {
    expect(parseEnvFile('K=v\r\n').K).toBe('v')
  })
})

describe('url derivation', () => {
  const env = {
    ANDPAY_DB_HOST: 'db.example.com',
    ANDPAY_DB_USER: 'mtms_dev',
    ANDPAY_DB_PASSWORD: 'aB cd#efg',
  }

  it('percent-encodes the password so the url parses back to the original', () => {
    const parsed = new URL(deriveUrls(env).IDENTITY_DATABASE_URL)
    expect(decodeURIComponent(parsed.password)).toBe('aB cd#efg')
    expect(parsed.hostname).toBe('db.example.com')
  })

  it('requires TLS on every derived url', () => {
    for (const url of Object.values(deriveUrls(env))) {
      expect(url).toContain('sslmode=require')
    }
  })

  it('derives exactly one url per context, each pinned to its own schema', () => {
    const urls = deriveUrls(env)
    expect(Object.keys(urls).sort()).toEqual([
      'ANALYTICS_DATABASE_URL',
      'AUTH_DATABASE_URL',
      'FULFILLMENT_DATABASE_URL',
      'IDENTITY_DATABASE_URL',
      'ORCHESTRATOR_DATABASE_URL',
      'TMS_DATABASE_URL',
    ])
    expect(urls.TMS_DATABASE_URL).toContain('?schema=tms&')
  })

  it('defaults the database name and port, and honours an override', () => {
    expect(deriveUrls(env).TMS_DATABASE_URL).toContain('@db.example.com:5432/andpay?')
    const overridden = deriveUrls({ ...env, ANDPAY_DB_PORT: '6543', ANDPAY_DB_NAME: 'other' })
    expect(overridden.TMS_DATABASE_URL).toContain('@db.example.com:6543/other?')
  })

  it('points the admin url at the maintenance database, never at andpay', () => {
    expect(deriveAdminUrl(env)).toContain('/postgres')
    expect(deriveAdminUrl(env)).not.toContain('/andpay')
  })

  it('throws naming every missing key at once', () => {
    expect(() => deriveUrls({ ANDPAY_DB_HOST: 'h' })).toThrow(/ANDPAY_DB_USER, ANDPAY_DB_PASSWORD/)
  })

  it('encodes the characters encodeURIComponent leaves alone, so no quote survives into a shell line', () => {
    expect(encodeUserinfo("a'b(c)*!")).toBe('a%27b%28c%29%2A%21')
  })

  it('percent-encodes a database name containing a single quote so it round-trips and no quote survives', () => {
    const url = deriveUrls({ ...env, ANDPAY_DB_NAME: "o'brien" }).TMS_DATABASE_URL
    expect(url).not.toContain("'")
    const parsed = new URL(url)
    expect(decodeURIComponent(parsed.pathname.slice(1))).toBe("o'brien")
  })

  it('rejects a host containing a single quote', () => {
    expect(() => deriveUrls({ ...env, ANDPAY_DB_HOST: "db'.example.com" })).toThrow(/ANDPAY_DB_HOST/)
  })

  it('rejects a host containing a space', () => {
    expect(() => deriveUrls({ ...env, ANDPAY_DB_HOST: 'db .example.com' })).toThrow(/ANDPAY_DB_HOST/)
  })

  it('rejects a non-numeric port', () => {
    expect(() => deriveUrls({ ...env, ANDPAY_DB_PORT: '54a2' })).toThrow(/ANDPAY_DB_PORT/)
  })

  it('accepts a bracketed IPv6 host literal', () => {
    const url = deriveUrls({ ...env, ANDPAY_DB_HOST: '[::1]' }).TMS_DATABASE_URL
    expect(url).toContain('@[::1]:5432/andpay?')
  })
})
