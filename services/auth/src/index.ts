// The Auth platform service (handoff spec 04). The sole holder of the ES256
// signing key, the 5c pepper, and the D121 stores; all Decision-3 token and
// class-6 credential issuance and lifecycle live here. Modules are added task by
// task; this entry re-exports the public surface as it grows.

// The Decision-3 token issuer identity (iss claim), verified locally by every
// consumer against the JWKS (16.3, T4).
export const AUTH_ISS = 'andpay-auth'

export * from './ports/kms-signing.js'
export * from './ports/pepper.js'
export * from './ports/mfa.js'
export * from './config/index.js'
