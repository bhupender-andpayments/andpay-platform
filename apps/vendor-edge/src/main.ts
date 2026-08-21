import 'reflect-metadata'
import { buildEdgeApp } from './app.module.js'
import { buildEdgeDepsFromEnv } from './deps.js'

// The real process bootstrap. Deferred: nothing under test/ imports this
// file (index.ts exports buildEdgeApp only), so it never runs under vitest.
async function bootstrap(): Promise<void> {
  const deps = await buildEdgeDepsFromEnv()
  const app = await buildEdgeApp(deps)
  await app.init()
  const port = process.env.PORT ?? 3000
  await app.listen(port)
}

// An unhandled rejection here (a missing VENDOR_EDGE_PEPPER, a DB connection
// failure) crashes the process by Node's default, which is the correct
// fail-closed behavior for a process that cannot serve requests safely.
void bootstrap()
