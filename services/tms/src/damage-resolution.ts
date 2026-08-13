import { dispatchGroupsFor, type DispatchGroup } from './assignment.js'

// T6.1, THE O-1 SEAM (13 Aug 2026).
//
// O-1 is the open question "when a bank reports damage, WHICH of the merchant's
// items are we replacing?" It is open because the walkthrough removed the only
// mechanism that answered it. FR08-1 let the damage file carry per-row item
// quantities, and D-20 rules those columns out: the file says a merchant's kit
// is damaged and says nothing about which part.
//
// This module is the single place that decision is made, so that when O-1 is
// answered the answer lands here and nowhere else. It was inline in damage.ts
// between the row match and the replacement mint, which meant every candidate
// answer would have been a rewrite of the ingest.
//
// WHAT THE INTERFACE HAS TO ADMIT. The candidates named on the O-1 call were:
//   - reason-implies-group: a battery fault means the soundbox, a torn standee
//     means the collateral. Needs the damage reason, so the input carries it.
//   - an ops-side picker: a human decides per row, later, out of band. Needs a
//     resolution that can say "not decidable here", so the output carries a
//     quarantine verdict rather than only a set of groups.
//   - accept over replacement: acknowledge the damage and send nothing.
//
// THE THIRD ONE DOES NOT FIT, and pretending otherwise would be the worse
// mistake. Today a damage CASE *is* the replacement assignment: case_status
// lives on the replacement row, so a case with no replacement has nowhere to
// exist. Accepting over replacement therefore needs a schema shape this repo
// does not have, not just another implementation of this interface. Saying so
// here is the point of writing the seam down: two of the three candidates cost
// one function, the third costs a table, and whoever answers O-1 should know
// that before they choose.

/** One matched original, at the grain the decision actually needs. */
export interface MatchedOriginal {
  dispatchGroup: DispatchGroup
  soundbox: boolean
  standeeCount: number
  stickerCount: number
}

/** One dispatch group to mint a replacement for. */
export interface ReplacementGroupSpec {
  group: DispatchGroup
  soundbox: boolean
  standeeCount: number
  stickerCount: number
}

export interface DamageResolutionInput {
  /** Every group of the ONE request the row matched (W-5: one or two). */
  originals: readonly MatchedOriginal[]
  /**
   * The damage reason as the file spelled it, already known to match an ACTIVE
   * row in the reason master (the caller checks that first). Carried because
   * reason-implies-group is a live candidate for O-1.
   */
  damageReason: string
  /**
   * The bank's free-text remarks. Carried for the same reason as the reason
   * label: a candidate resolution may read it. NEVER logged, and never written
   * anywhere but the domain row it came from (S7).
   */
  bankRemarks: string
  /**
   * The file's per-row item spec, when the profile still maps one. D-20 removes
   * these columns, so this is undefined on every path after T6.2; it stays in
   * the input shape because a source profile that still carries them must
   * resolve identically to how it always did.
   */
  items?: { soundbox: boolean; standeeCount: number; stickerCount: number }
}

export type DamageResolution =
  | { kind: 'replace'; groups: ReplacementGroupSpec[] }
  /**
   * The strategy cannot decide. The row is HELD, never guessed at: this is the
   * fallback posture the damage ingest already takes for a row it cannot match,
   * and it is what makes an ops-side picker implementable without inventing a
   * partial replacement in the meantime.
   */
  | { kind: 'quarantine'; reasonCode: 'no_match' }

export type DamagedCollateralResolution = (input: DamageResolutionInput) => DamageResolution

/**
 * IMPLEMENTATION 1: exactly what the platform did before the seam existed.
 *
 * Honour the file's item spec when the profile supplied one; otherwise clone the
 * matched request like-for-like, which for a two-group request is the union of
 * both groups' products. A group that would carry nothing is dropped rather than
 * minted as a meaningless replacement, and if that leaves nothing at all the row
 * is held.
 *
 * This is deliberately a FAITHFUL COPY and not an improvement. The seam's job on
 * the day it lands is to change nothing; O-1's answer is what changes behaviour,
 * and it should arrive as its own diff against a baseline that is provably
 * identical to what came before.
 */
export const cloneMatchedRequest: DamagedCollateralResolution = (input) => {
  const soundbox = input.items?.soundbox ?? input.originals.some((m) => m.soundbox)
  const standeeCount = input.items?.standeeCount ?? Math.max(...input.originals.map((m) => m.standeeCount), 0)
  const stickerCount = input.items?.stickerCount ?? Math.max(...input.originals.map((m) => m.stickerCount), 0)

  // dispatchGroupsFor's ORPHAN RULE (a request that ordered nothing still gets a
  // visible COLLATERAL group) does not apply to damage: a zero-count COLLATERAL
  // group here means the damage names nothing collateral at all, so it is
  // filtered out rather than minted.
  const groups = dispatchGroupsFor({ soundbox, standee_count: standeeCount, sticker_count: stickerCount }).filter(
    (g) => g.group === 'SOUNDBOX' || g.standeeCount > 0 || g.stickerCount > 0,
  )
  if (groups.length === 0) return { kind: 'quarantine', reasonCode: 'no_match' }
  return { kind: 'replace', groups }
}

/**
 * The strategy the damage ingest uses.
 *
 * A module-level constant rather than a parameter threaded through every caller,
 * because there is exactly one policy in force at a time and it is a platform
 * decision, not a per-call one. When O-1 is answered this is the line that
 * changes, and the ingest does not.
 */
export const activeDamageResolution: DamagedCollateralResolution = cloneMatchedRequest
