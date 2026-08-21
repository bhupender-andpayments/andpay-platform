import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Damage-case status parity, the same shape as the other vocabulary guards
// (C4: the portal cannot import from a service, so the values are duplicated by
// hand and a hand copy can drift).
//
// WHAT WENT WRONG HERE, which no test was watching. This vocabulary was spelled
// THREE ways at once: services/tms wrote 'In-Progress', the portal's move list
// wrote 'In Progress', and the portal's ?status= filter list wrote 'In-Progress'
// again. The server normalized every spelling on the way in, so nothing failed
// loudly, and the cost surfaced only as a UI bug: an in-progress case was
// offered "In Progress" as somewhere to move to, because one comparison used
// `===` across two spellings and could never match.
//
// As of 21 Aug 2026 the hyphenated form is canonical, the database enforces it
// (assignment_case_status_check), and both portal lists use it. This test is
// what keeps that true.
//
// Both sides are read as TEXT here, the service because no import may link it to
// the portal, and the portal because its constants live inside a .tsx page
// component that would drag React into a node-project test.
const root = join(import.meta.dirname, '..')

function serviceStatuses(): string[] {
  const text = readFileSync(join(root, 'services', 'tms', 'src', 'damage-case.ts'), 'utf8')
  const start = text.indexOf('export const CASE_STATUS_VALUES')
  const end = text.indexOf(']', start)
  return [...text.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

function portalText(): string {
  return readFileSync(
    join(root, 'apps', 'ops-portal', 'src', 'features', 'damage', 'DamageCasesPage.tsx'),
    'utf8',
  )
}

function portalList(marker: string): string[] {
  const text = portalText()
  const start = text.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const end = text.indexOf(']', start)
  return [...text.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

describe('damage case status parity between services/tms and apps/ops-portal', () => {
  it('finds a non-empty set on the service side', () => {
    expect(serviceStatuses().length).toBeGreaterThan(0)
  })

  it('the service spells the middle value with a hyphen, which is the canonical form', () => {
    expect(serviceStatuses()).toContain('In-Progress')
    expect(serviceStatuses()).not.toContain('In Progress')
  })

  it("the portal's ?status= filters are exactly the service's values", () => {
    expect(portalList('const STATUS_FILTERS =').sort()).toEqual([...serviceStatuses()].sort())
  })

  // THE REGRESSION THIS FILE EXISTS FOR. The move list's `wire` values are what
  // the portal SENDS, so a spelling here that the filters do not share is the
  // exact divergence that produced the bug described at the top.
  it('the portal offers no second spelling of the middle value', () => {
    const moves = portalList('const CASE_MOVES =')
    expect(moves).toContain('In-Progress')
    expect(moves).not.toContain('In Progress')
  })

  it('the move list and the filter list agree, so a comparison between them cannot silently fail', () => {
    // CASE_MOVES interleaves wire and label strings, so compare as a set
    // containment rather than position for position.
    const moves = portalList('const CASE_MOVES =')
    for (const s of portalList('const STATUS_FILTERS =')) {
      expect(moves).toContain(s)
    }
  })

  // Cancelled is granted by the DB CHECK for the damage cancel flow (DAMAGE.md)
  // and nothing writes it yet. When that flow is built, this assertion is the
  // reminder that BOTH sides have to learn the value together.
  it('records that Cancelled is not yet part of either side vocabulary', () => {
    expect(serviceStatuses()).not.toContain('Cancelled')
    expect(portalList('const STATUS_FILTERS =')).not.toContain('Cancelled')
  })
})
