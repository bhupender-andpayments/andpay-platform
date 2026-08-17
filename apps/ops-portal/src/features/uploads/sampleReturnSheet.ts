import { csvLine } from '../../lib/csv.js'
import type { BatchEntryRow } from '../../api/endpoints.js'

// TESTING AID, not a product surface. Third of the sample-file generators, and
// the one that is NOT a pure string builder in the same sense as the other two.
//
// WHY THIS ONE IS DIFFERENT. The inventory and bank samples invent their own
// identities, so a file can be conjured from a clock reading. A return sheet
// cannot: it is the dispatch sheet WE generated coming back, so every row must
// name a Dispatch ID that already exists, is already batched, and is still
// waiting on its vendor, and pair it with a device that exists and is not
// already paired. Invented ids quarantine as invalid_asgn_id or asgn_not_found,
// which is exactly the demo failure this is meant to prevent.
//
// So the generator is PURE but not self-contained: the page fetches the live
// batch, its entries, the free device serials and an active courier, and this
// builds the sheet from them. Keeping the fetch out here is what makes it
// testable without standing up a client, the same property the other two have.
//
// WHAT THE INGEST DEMANDS (services/fulfillment/src/return-sheet.ts):
//   - FILE LEVEL: the vendor is resolved from the batch the dispatches belong
//     to, so a file spanning two vendors' batches is refused whole
//     (mixed_vendors) and a batch with no bound print vendor is refused
//     (batch_has_no_vendor). Hence: ONE batch, and only one that has a vendor.
//   - The Dispatch ID must parse as an asgn_ wire id (invalid_asgn_id) and must
//     resolve to a pooled entry that HAS a batch and a merchant
//     (asgn_not_found). Hence: real ids straight off the batch detail.
//   - THE W-5 GROUP GATES, and they are strict in BOTH directions. A SOUNDBOX
//     row without a serial quarantines (device_required_for_soundbox); a
//     COLLATERAL row WITH one quarantines (unexpected_device_for_collateral).
//     Hence the split below, rather than putting a serial on every row.
//   - A device already paired quarantines (unit_already_paired). Hence only
//     serials the caller has already filtered to unpaired.
//   - Courier is OPTIONAL: absent is fine and the shipment simply carries no
//     courier partner, but an unrecognised code quarantines (unknown_courier).
//     Hence the column is emitted ONLY when a real ACTIVE courier code is
//     supplied, never invented.
//
// THE HONEST LIMIT. Unlike the other two, this sample CONSUMES real pending
// work: each download names dispatches that are still awaiting return, and once
// they are returned they stop being eligible. It is repeatable while unreturned
// dispatches and free devices remain, and it says so plainly when they do not,
// rather than emitting a file that quarantines.

/** Header, using the spellings the adapter's own HEADERS map accepts first. */
const BASE_HEADER = ['Dispatch ID', 'Device ID', 'AWB'] as const
const COURIER_HEADER = 'Courier'

/**
 * Caps, so a 30 entry batch does not produce a 30 row sample nobody reads. Both
 * are ceilings, not targets: the real bound is what is actually available.
 */
const MAX_SOUNDBOX_ROWS = 6
const MAX_COLLATERAL_ROWS = 4

/** The dispatch state that means "sent to the vendor, not yet returned". */
const AWAITING_RETURN = 'SENT_TO_VENDOR'

export interface SampleReturnSource {
  /** The batch every row belongs to. One batch only: mixed_vendors is fatal. */
  batchId: string
  entries: readonly BatchEntryRow[]
  /** Serials the caller has ALREADY filtered to in-stock and unpaired. */
  freeSerials: readonly string[]
  /** An ACTIVE courier's code, or null to omit the optional column entirely. */
  courierCode: string | null
}

export interface SampleReturnFile {
  filename: string
  csv: string
  batchId: string
  soundboxRows: number
  collateralRows: number
  /** The two consignment AWBs, so the caller can name them in a toast. */
  awbs: string[]
}

export type SampleReturnOutcome =
  | { ok: true; file: SampleReturnFile }
  | { ok: false; problem: string }

function digits(n: number, width: number): string {
  return String(n).padStart(width, '0').slice(-width)
}

/**
 * A fresh AWB per consignment per download. One AWB is one shipment: the ingest
 * dedups shpt birth ON the AWB, so reusing one across downloads would attach
 * new rows to the earlier shipment instead of creating this one.
 */
function awbFor(runMs: number, runSalt: number, leg: number): string {
  return `${digits(runMs, 9)}${digits(runSalt, 2)}${leg}`
}

/**
 * Builds one return sheet whose rows all ingest, or explains why it cannot.
 *
 * Rows are grouped onto TWO AWBs, soundbox under one and collateral under the
 * other, because that is how the parcels actually travel and it is the case the
 * ingest comments call out (one dispatch id under two AWBs, the kit under one
 * and the standee under another).
 */
export function buildSampleReturnSheet(
  source: SampleReturnSource,
  now: Date = new Date(),
  salt: number = Math.floor(Math.random() * 100),
): SampleReturnOutcome {
  const runMs = now.getTime()

  // Only entries still awaiting their vendor. A returned dispatch has moved on,
  // and naming it again would either dedup to nothing or attach a second
  // shipment to a leg that already has one.
  const awaiting = source.entries.filter((e) => e.dispatchState === AWAITING_RETURN)

  // A null dispatchGroup is a legacy pre-split combined row. Neither group gate
  // fires on it, so it would ingest, but which shape it wants is genuinely
  // ambiguous. Skipped rather than guessed: a sample must not be the place a
  // legacy grain gets an opinion.
  const soundboxEntries = awaiting.filter((e) => e.dispatchGroup === 'SOUNDBOX')
  const collateralEntries = awaiting.filter((e) => e.dispatchGroup === 'COLLATERAL')

  const soundboxCount = Math.min(soundboxEntries.length, source.freeSerials.length, MAX_SOUNDBOX_ROWS)
  const collateralCount = Math.min(collateralEntries.length, MAX_COLLATERAL_ROWS)

  if (soundboxCount === 0 && collateralCount === 0) {
    // Say which of the two ran out, because the fix differs: one needs a batch,
    // the other needs devices.
    if (awaiting.length === 0) {
      return {
        ok: false,
        problem:
          'Every dispatch in the latest batch has already been returned. Trigger a new batch, or upload bank requests and batch them first.',
      }
    }
    return {
      ok: false,
      problem:
        'The batch is waiting on soundbox rows but no unpaired devices are in stock. Upload a device inventory file first, then try again.',
    }
  }

  const soundboxAwb = awbFor(runMs, salt, 1)
  const collateralAwb = awbFor(runMs, salt, 2)
  const withCourier = source.courierCode !== null

  const header = withCourier ? [...BASE_HEADER, COURIER_HEADER] : [...BASE_HEADER]
  const lines: string[] = [csvLine(header)]

  const row = (asgnId: string, serial: string, awb: string): string =>
    csvLine(withCourier ? [asgnId, serial, awb, source.courierCode!] : [asgnId, serial, awb])

  for (let i = 0; i < soundboxCount; i += 1) {
    lines.push(row(soundboxEntries[i]!.asgnId, source.freeSerials[i]!, soundboxAwb))
  }
  // Device ID stays BLANK here, deliberately. The column is required, the value
  // is not, and a serial on a collateral row is its own quarantine reason.
  for (let i = 0; i < collateralCount; i += 1) {
    lines.push(row(collateralEntries[i]!.asgnId, '', collateralAwb))
  }

  const awbs: string[] = []
  if (soundboxCount > 0) awbs.push(soundboxAwb)
  if (collateralCount > 0) awbs.push(collateralAwb)

  return {
    ok: true,
    file: {
      filename: `sample-vendor-return-${now.toISOString().slice(0, 10)}-${digits(runMs, 6)}${digits(salt, 2)}.csv`,
      csv: `${lines.join('\n')}\n`,
      batchId: source.batchId,
      soundboxRows: soundboxCount,
      collateralRows: collateralCount,
      awbs,
    },
  }
}

/**
 * Picks the batch a sample should be built from: the newest one that has a
 * bound print vendor, because a batch without one is refused whole
 * (batch_has_no_vendor) and picking it would produce a file that cannot work.
 */
export function selectSampleReturnBatch<T extends { id: string; printVndr: string | null; createdAt: string }>(
  batches: readonly T[],
): T | null {
  return (
    [...batches]
      .filter((b) => b.printVndr !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  )
}
