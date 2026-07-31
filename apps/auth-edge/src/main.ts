import 'reflect-metadata'
import { buildAuthEdgeApp } from './app.module.js'
import { buildAuthEdgeDepsFromEnv } from './deps.js'

// The real process bootstrap. Deferred: nothing under test/ imports this file
// (index.ts exports buildAuthEdgeApp only), so it never runs under vitest.
async function bootstrap(): Promise<void> {
  const deps = await buildAuthEdgeDepsFromEnv()
  const app = await buildAuthEdgeApp(deps)
  await app.init()
  const port = process.env.PORT ?? 3000
  await app.listen(port)
}

// An unhandled rejection here (a missing AUTH_EDGE_ISS/AUTH_PORTAL_ORIGIN, a
// DB connection failure) crashes the process by Node's default, which is the
// correct fail-closed behavior for a process that cannot serve requests
// safely.
void bootstrap()
