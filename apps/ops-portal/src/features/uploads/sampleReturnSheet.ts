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

/**
 * One downloadable file. Two of these come back from one build, soundbox and
 * collateral, mirroring the two vendor Excels an operator already downloads
 * for the same batch (18 Aug 2026, at the user's correction): a real return
 * sheet arrives from the vendor as two files, one per delivery group, never
 * one CSV with both grains stacked in it.
 */
export interface SampleReturnFile {
  filename: string
  csv: string
  rows: number
  /** One AWB per row (18 Aug 2026): a real shipment is one parcel, and two
   *  dispatches sharing one AWB in the sample was never how they travel. */
  awbs: string[]
}

export interface SampleReturnBundle {
  batchId: string
  /** Null when the batch has no eligible SOUNDBOX rows or no free devices. */
  soundbox: SampleReturnFile | null
  /** Null when the batch has no eligible COLLATERAL rows. */
  collateral: SampleReturnFile | null
}

export type SampleReturnOutcome =
  | { ok: true; file: SampleReturnBundle }
  | { ok: false; problem: string }

function digits(n: number, width: number): string {
  return String(n).padStart(width, '0').slice(-width)
}

/**
 * A fresh AWB per ROW per download (18 Aug 2026, at the user's correction: a
 * real parcel does not share its tracking number with nine others). `slot`
 * must be unique across the whole build, soundbox and collateral together, so
 * the two files this produces never collide with each other either. One AWB
 * is one shipment: the ingest dedups shpt birth ON the AWB, so a reused one
 * would attach new rows to an earlier shipment instead of creating this one.
 */
function awbFor(runMs: number, runSalt: number, slot: number): string {
  return `${digits(runMs, 9)}${digits(runSalt, 2)}${digits(slot, 4)}`
}

/** One delivery group's file: its own header, its own rows, its own AWBs. */
function buildGroupFile(
  filenamePrefix: string,
  rows: ReadonlyArray<{ asgnId: string; serial: string; awb: string }>,
  courierCode: string | null,
): SampleReturnFile | null {
  if (rows.length === 0) return null
  const withCourier = courierCode !== null
  const header = withCourier ? [...BASE_HEADER, COURIER_HEADER] : [...BASE_HEADER]
  const lines: string[] = [csvLine(header)]
  for (const r of rows) {
    lines.push(csvLine(withCourier ? [r.asgnId, r.serial, r.awb, courierCode!] : [r.asgnId, r.serial, r.awb]))
  }
  return {
    filename: `${filenamePrefix}.csv`,
    csv: `${lines.join('\n')}\n`,
    rows: rows.length,
    awbs: rows.map((r) => r.awb),
  }
}

/**
 * Builds the batch's return sheets, one per delivery group, or explains why it
 * cannot. TWO FILES, not one (18 Aug 2026, at the user's correction): a real
 * return sheet arrives from the print vendor as two files, soundbox and
 * collateral, exactly mirroring the two vendor Excels already downloaded for
 * this batch, never one CSV with both grains stacked in it. Each row gets its
 * own AWB, and nothing here caps how much of the batch is covered: the only
 * real ceiling is how many free devices exist for the soundbox rows.
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

  const soundboxCount = Math.min(soundboxEntries.length, source.freeSerials.length)
  const collateralCount = collateralEntries.length

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

  const soundboxRows = Array.from({ length: soundboxCount }, (_, i) => ({
    asgnId: soundboxEntries[i]!.asgnId,
    serial: source.freeSerials[i]!,
    awb: awbFor(runMs, salt, i),
  }))
  // Collateral slots start right after the soundbox count, so the two files'
  // AWBs never collide however large this batch is, with no magic ceiling to
  // outgrow.
  // Device ID stays BLANK here, deliberately. The column is required, the
  // value is not, and a serial on a collateral row is its own quarantine
  // reason.
  const collateralRows = Array.from({ length: collateralCount }, (_, i) => ({
    asgnId: collateralEntries[i]!.asgnId,
    serial: '',
    awb: awbFor(runMs, salt, soundboxCount + i),
  }))

  return {
    ok: true,
    file: {
      batchId: source.batchId,
      soundbox: buildGroupFile(`${source.batchId}-return-soundbox`, soundboxRows, source.courierCode),
      collateral: buildGroupFile(`${source.batchId}-return-collateral`, collateralRows, source.courierCode),
    },
  }
}

// selectSampleReturnBatch was REMOVED 18 Aug 2026. It picked the newest batch
// with a bound print vendor when the caller named none, and that guess is what
// read as "the sample downloads a random batch": an operator got a file for
// whichever batch happened to be newest rather than the one they meant. The
// control is now only offered with a batch already in scope
// (ReturnUploadPage's `?batch=`), so there is nothing left to guess from.
