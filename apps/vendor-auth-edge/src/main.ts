import 'reflect-metadata'
import { buildVendorAuthEdgeApp } from './app.module.js'
import { buildVendorAuthEdgeDepsFromEnv } from './deps.js'

// The real process bootstrap. Deferred: nothing under test/ imports this
// file (index.ts exports buildVendorAuthEdgeApp only), so it never runs
// under vitest.
async function bootstrap(): Promise<void> {
  const deps = await buildVendorAuthEdgeDepsFromEnv()
  const app = await buildVendorAuthEdgeApp(deps)
  await app.init()
  const port = process.env.PORT ?? 3000
  await app.listen(port)
}

// An unhandled rejection here (a missing VENDOR_AUTH_ISS/VENDOR_PORTAL_ORIGIN,
// a DB connection failure) crashes the process by Node's default, which is
// the correct fail-closed behavior for a process that cannot serve requests
// safely.
void bootstrap()
