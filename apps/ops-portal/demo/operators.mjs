// The seeded demo operator(s). Shared by serve.mjs (which provisions them) and
// totp.mjs (which prints the current code). Throwaway credentials for a local
// seeded demo only. The principal id must be a valid UUID (mfa_enrollment and
// internal_principal key it as @db.Uuid).
export const OPERATORS = [
  {
    id: '99999999-9999-4999-8999-999999999999',
    handle: 'ops.admin',
    password: 'demo-Ops-2026!',
    role: 'admin',
  },
]

export const AUTH_DB_URL = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
export const TOTP_ISSUER = 'AndPayments Ops (demo)'
