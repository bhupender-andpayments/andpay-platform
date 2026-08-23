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
// THE MOVE LIST IS GONE (24 Aug 2026, at the user's direction). Every forward
// transition is automatic: a case opens on the flag, goes In-Progress when its
// replacement is batched, and closes when that replacement activates or is
// delivered. `CASE_MOVES` became `CASE_STATUSES`, a LABEL and TILE vocabulary
// rather than a list of doors, and Cancelled joined it because a withdrawn case
// needs a name and a tile. The parity question is unchanged and still worth
// asking: does the portal ever spell a value the service does not write.
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

  // The portal must never invent a value the service does not write, which is
  // the drift this file exists to catch. Since 24 Aug the two sets match
  // exactly: every status the service knows has a filter and a tile.
  it("every ?status= filter the portal offers is a value the service actually writes", () => {
    for (const f of portalList('const STATUS_FILTERS =')) {
      expect(serviceStatuses()).toContain(f)
    }
  })

  // THE REGRESSION THIS FILE EXISTS FOR: one vocabulary, one spelling. The
  // labels and filters are compared against each other below for the same
  // reason, because a mismatch between them is what produced the original bug.
  it('the portal offers no second spelling of the middle value', () => {
    const statuses = portalList('const CASE_STATUSES =')
    expect(statuses).toContain('In-Progress')
    expect(statuses).not.toContain('In Progress')
  })

  it('the status list and the filter list agree, so a comparison between them cannot silently fail', () => {
    // CASE_STATUSES interleaves wire and label strings, so compare as a set
    // containment rather than position for position.
    const statuses = portalList('const CASE_STATUSES =')
    for (const s of portalList('const STATUS_FILTERS =')) {
      expect(statuses).toContain(s)
    }
  })

  // Cancelled LANDED on 21 Aug 2026 and became a FIRST-CLASS status on 24 Aug:
  // the service writes it, the portal labels it, filters it and gives it a tile.
  it('the service and the portal agree that Cancelled is a real status', () => {
    expect(serviceStatuses()).toContain('Cancelled')
    expect(portalList('const CASE_STATUSES =')).toContain('Cancelled')
    expect(portalList('const STATUS_FILTERS =')).toContain('Cancelled')
  })

  // THE STRONGER GUARD THAT REPLACED "Cancelled is not a move" (24 Aug 2026).
  // There are no moves at all now, so rather than pin one value out of a list
  // that no longer exists, pin the rule: this page must not call the status
  // write. Every forward transition is the automation's, and a hand-made move
  // would only be overruled by the next fact.
  it('the page never calls the case-status write: transitions are the automation\'s', () => {
    expect(portalText()).not.toContain('updateDamageCaseStatus')
  })
})
