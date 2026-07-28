import { describe, it } from 'vitest'
// The Step-1 inventory drives these. Each todo names the file(s) it will guard.
// Activated in Task 8 (no-owner guard + negatives), Task 5 (Fork B harness),
// Task 7 (orchestrator). Kept as todos here so main stays green (Global Constraints).
describe('10d write-plane C4 (cross-cutting)', () => {
  it.todo('check 1/4: every program-scoped writer references enterWriteScope; no bare owner writer [Task 8]')
  it.todo('check 4: no workload/infra role has BYPASSRLS or table ownership (pg_roles) [Task 8]')
  it.todo('check 4: cross-schema write under a context role denied by Postgres [Task 8]')
  it.todo('check 10: planted new-table write fails closed until GRANT added; no ALTER DEFAULT PRIVILEGES [Task 8]')
  it.todo('check 8: server-side program resolution ignores a spoofed program value [Task 8]')
  it.todo('check 3: Fork B relay/engine/appender roles harness-proven cross-program [Task 5]')
  it.todo('check 7: dead orchestrator_write role, no handler, no src [Task 7]')
})
