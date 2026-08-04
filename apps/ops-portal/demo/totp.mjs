// Prints the current TOTP 6-digit code(s) for the seeded demo operator(s).
// Reads the throwaway secrets serve.mjs wrote to .demo-totp.json (a
// demo-authored artifact, not a real credential store). Run serve.mjs first.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { authenticator } from 'otplib'

const HERE = dirname(fileURLToPath(import.meta.url))
let entries
try {
  entries = JSON.parse(readFileSync(join(HERE, '.demo-totp.json'), 'utf8'))
} catch {
  console.error('No .demo-totp.json found. Start the runtime first: pnpm --filter @andpay/ops-portal demo:serve')
  process.exit(1)
}
for (const e of entries) {
  console.log(`${e.handle}: ${authenticator.generate(e.secret)}`)
}
