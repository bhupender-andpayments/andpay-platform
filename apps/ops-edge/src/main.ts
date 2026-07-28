import 'reflect-metadata'
import { buildOpsEdgeApp } from './app.module.js'
import { buildOpsEdgeDepsFromEnv } from './deps.js'

// The real process bootstrap. Deferred: nothing under test/ imports this file
// (index.ts exports buildOpsEdgeApp only), so it never runs under vitest.
async function bootstrap(): Promise<void> {
  const deps = buildOpsEdgeDepsFromEnv()
  const app = await buildOpsEdgeApp(deps)
  await app.init()
  const port = process.env.PORT ?? 3000
  await app.listen(port)
}

// An unhandled rejection here (a missing OPS_EDGE_JWKS/OPS_EDGE_ISS, a DB
// connection failure) crashes the process by Node's default, which is the
// correct fail-closed behavior for a process that cannot serve requests safely.
void bootstrap()
