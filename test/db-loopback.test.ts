import { describe, it, expect } from 'vitest'
import { isLoopbackUrl, nonLoopbackVars, loopbackViolationMessage, SCOPED_URL_VARS } from './db-loopback.js'

describe('loopback detection', () => {
  it('accepts every form of the local docker Postgres', () => {
    expect(isLoopbackUrl('postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms')).toBe(true)
    expect(isLoopbackUrl('postgresql://andpay:andpay_dev@127.0.0.1:5432/andpay?schema=tms')).toBe(true)
    expect(isLoopbackUrl('postgresql://andpay:andpay_dev@[::1]:5432/andpay?schema=tms')).toBe(true)
  })

  it('rejects a shared RDS endpoint', () => {
    expect(isLoopbackUrl('postgresql://u:p@db.abc123.ap-south-1.rds.amazonaws.com:5432/andpay?schema=tms')).toBe(false)
  })

  it('is not fooled by a loopback-looking password, user, or database name', () => {
    expect(isLoopbackUrl('postgresql://localhost:localhost@evil.example.com:5432/localhost')).toBe(false)
  })

  it('fails closed on an unparseable url', () => {
    expect(isLoopbackUrl('not a url')).toBe(false)
    expect(isLoopbackUrl('')).toBe(false)
  })
})

describe('loopback plus TLS: a port-forwarded shared instance also presents as localhost', () => {
  it('accepts a plain localhost url', () => {
    expect(isLoopbackUrl('postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms')).toBe(true)
  })

  it('rejects a localhost url that carries sslmode=require, a probable tunnel to shared infrastructure', () => {
    expect(
      isLoopbackUrl('postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms&sslmode=require'),
    ).toBe(false)
  })

  it('accepts a localhost url that explicitly disables TLS', () => {
    expect(
      isLoopbackUrl('postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms&sslmode=disable'),
    ).toBe(true)
  })
})

describe('offender detection across the environment', () => {
  it('returns nothing when every variable is unset, which is the normal local case', () => {
    expect(nonLoopbackVars({})).toEqual([])
  })

  it('ignores an empty string, which is an unset variable in practice', () => {
    expect(nonLoopbackVars({ TMS_DATABASE_URL: '' })).toEqual([])
  })

  it('names every offending variable, not just the first', () => {
    const offenders = nonLoopbackVars({
      TMS_DATABASE_URL: 'postgresql://u:p@shared.rds.amazonaws.com:5432/andpay?schema=tms',
      AUTH_DATABASE_URL: 'postgresql://u:p@shared.rds.amazonaws.com:5432/andpay?schema=auth',
      IDENTITY_DATABASE_URL: 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity',
    })
    expect(offenders.sort()).toEqual(['AUTH_DATABASE_URL', 'TMS_DATABASE_URL'])
  })

  it('covers the outbox library test url and the admin bootstrap url, as well as the six contexts', () => {
    expect(SCOPED_URL_VARS).toContain('OUTBOX_TEST_DATABASE_URL')
    expect(SCOPED_URL_VARS).toContain('ANDPAY_ADMIN_DATABASE_URL')
    expect(SCOPED_URL_VARS).toHaveLength(8)
  })
})

describe('the violation message', () => {
  it('names the offenders and tells the reader how to recover', () => {
    const message = loopbackViolationMessage(['TMS_DATABASE_URL'])
    expect(message).toContain('TMS_DATABASE_URL')
    expect(message).toContain('TRUNCATE')
    expect(message).toContain('pnpm db:up')
  })
})
