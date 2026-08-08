import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Redesign principle 2, enforced: NEVER ask the operator for an identifier they
// must remember. Ids may be displayed and copied, never required as input.
//
// This is prose until something fails on it. A placeholder like `tnnt_...` is
// the tell: it exists only because the field expects a wire id typed by hand.
//
// A RATCHET, not a clean sweep. The violations below are real and are removed as
// each screen moves onto the EntityPicker. Two assertions hold the ratchet:
//   1. no violation outside this list, so a NEW typed-id box fails immediately
//   2. no STALE entry in this list, so a file that stops violating must be
//      deleted from it and can never quietly regress back in
// Together the list can only shrink. Do not add to it.
const src = join(import.meta.dirname, '..', '..', 'src')

// Prefixes come from @andpay/ids. `api_` and `apsk_` are deliberately excluded:
// those are credentials, never entered in this portal at all.
const TYPED_ID_PLACEHOLDER = /placeholder="(tnnt_|prg_|btch_|asgn_|mrch_|smrch_|vndr_|shpt_)/

// EMPTY, AND IT MUST STAY EMPTY.
//
// This started at six typed wire ids across four screens and reached zero:
// step 3 took BatchPage's tnnt_/prg_/btch_, step 8 took the last three asgn_
// ones (Hold and Release became actions on the pool row they act on, Recompose
// picks its record). The ban is now absolute rather than a ratchet.
//
// Do NOT add an entry here to make a new screen pass. Use EntityPicker: the
// operator searches by what they call the thing and the component hands you the
// id. Every justification for free text in this repo took the same form, "no
// read discovers one of these", and every one of them expired when the
// object-spine reads landed without anybody going back to check.
const KNOWN_DEBT: Readonly<Record<string, number>> = {}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return tsxFiles(full)
    return full.endsWith('.tsx') ? [full] : []
  })
}

function violationsByFile(): Map<string, number> {
  const found = new Map<string, number>()
  for (const file of tsxFiles(src)) {
    const text = readFileSync(file, 'utf8')
    const count = text.split('\n').filter((line) => TYPED_ID_PLACEHOLDER.test(line)).length
    if (count > 0) found.set(relative(src, file), count)
  }
  return found
}

describe('typed-id ban: no screen asks the operator to type a wire id', () => {
  it('has files to scan', () => {
    expect(tsxFiles(src).length).toBeGreaterThan(10)
  })

  it('introduces no NEW typed-id input', () => {
    const offenders = [...violationsByFile().keys()].filter((f) => !(f in KNOWN_DEBT)).sort()
    expect(
      offenders,
      'A new hand-typed wire id was added. Use EntityPicker: the operator searches by name and the component hands you the id.',
    ).toEqual([])
  })

  it('carries no STALE debt entry, so the list can only shrink', () => {
    const actual = violationsByFile()
    const stale = Object.keys(KNOWN_DEBT).filter((f) => !actual.has(f)).sort()
    expect(
      stale,
      'These files no longer type a wire id. Delete them from KNOWN_DEBT so they cannot regress.',
    ).toEqual([])
  })

  it('records the exact remaining count per file, so a silent increase fails', () => {
    const actual = violationsByFile()
    const drift = Object.entries(KNOWN_DEBT)
      .filter(([file, expected]) => actual.get(file) !== expected)
      .map(([file, expected]) => `${file}: expected ${expected}, found ${actual.get(file) ?? 0}`)
    expect(drift).toEqual([])
  })
})
