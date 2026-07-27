import 'reflect-metadata'
import { buildTenantEdgeApp } from './app.module.js'
import { buildTenantEdgeDepsFromEnv } from './deps.js'

// The real process bootstrap. Deferred: nothing under test/ imports this file
// (index.ts exports buildTenantEdgeApp only), so it never runs under vitest.
async function bootstrap(): Promise<void> {
  const deps = buildTenantEdgeDepsFromEnv()
  const app = await buildTenantEdgeApp(deps)
  await app.init()
  const port = process.env.PORT ?? 3000
  await app.listen(port)
}

// An unhandled rejection here (a missing TENANT_EDGE_JWKS/TENANT_EDGE_ISS, a DB
// connection failure) crashes the process by Node's default, which is the
// correct fail-closed behavior for a process that cannot serve requests safely.
void bootstrap()
