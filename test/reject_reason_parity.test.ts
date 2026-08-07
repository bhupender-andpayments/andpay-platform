import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// P-A parity guard. The ops portal renders the row-level reject reasons that
// services/tms produces, but it cannot IMPORT them: a portal importing a service
// would be a cross-context dependency (C4). So the union is duplicated by hand
// in apps/ops-portal/src/api/endpoints.ts, and a hand-copied union silently
// drifts.
//
// It HAD drifted. Before this guard, the service could return
// `missing_branch_code` (added in Phase 3 Task 4) and the portal type had never
// listed it, so a real wire value had no declared type for the entire life of
// that feature. That is the exact failure this test exists to prevent.
//
// Deliberately a TEXT comparison of the two declarations rather than a type-level
// check: the whole point is that no import links these two files, so only reading
// the source can prove they agree.
const root = join(import.meta.dirname, '..')

function unionMembers(text: string, typeName: string): string[] {
  // Matches both the single-line (`type X = 'a' | 'b'`) and the multi-line
  // leading-pipe style, up to the first blank line after the declaration.
  const start = text.indexOf(`export type ${typeName} =`)
  if (start === -1) throw new Error(`${typeName} declaration not found`)
  const after = text.slice(start)
  const end = after.indexOf('\n\n')
  const decl = end === -1 ? after : after.slice(0, end)
  return [...decl.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!).sort()
}

describe('RequestRowRejectReason parity between services/tms and apps/ops-portal', () => {
  const serviceText = readFileSync(join(root, 'services', 'tms', 'src', 'ingest.ts'), 'utf8')
  const portalText = readFileSync(join(root, 'apps', 'ops-portal', 'src', 'api', 'endpoints.ts'), 'utf8')

  it('finds a non-empty union on both sides', () => {
    expect(unionMembers(serviceText, 'RequestRowRejectReason').length).toBeGreaterThan(0)
    expect(unionMembers(portalText, 'RequestRowRejectReason').length).toBeGreaterThan(0)
  })

  it('the portal declares exactly the reasons the service can return', () => {
    expect(unionMembers(portalText, 'RequestRowRejectReason')).toEqual(
      unionMembers(serviceText, 'RequestRowRejectReason'),
    )
  })
})
