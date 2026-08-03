import { describe, it, expect, beforeEach } from 'vitest'
import { getAccessToken, setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

describe('tokenStore', () => {
  beforeEach(() => { clearAccessToken(); localStorage.clear(); sessionStorage.clear() })

  it('holds the token in memory and returns it', () => {
    expect(getAccessToken()).toBeNull()
    setAccessToken('tok-abc')
    expect(getAccessToken()).toBe('tok-abc')
  })

  it('NEVER writes the token to localStorage, sessionStorage, or cookie (check 1)', () => {
    setAccessToken('secret-token')
    expect(JSON.stringify(localStorage)).not.toContain('secret-token')
    expect(JSON.stringify(sessionStorage)).not.toContain('secret-token')
    expect(document.cookie).not.toContain('secret-token')
  })

  it('clearAccessToken wipes memory', () => {
    setAccessToken('tok'); clearAccessToken(); expect(getAccessToken()).toBeNull()
  })
})
