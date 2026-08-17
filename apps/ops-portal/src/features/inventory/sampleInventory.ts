// TESTING AID, not a product surface. Generates one device-inventory CSV that
// passes ingest every time it is downloaded.
//
// WHY IT EXISTS. Demoing the inventory upload needs a file that ingests
// cleanly, and the checked-in demo assets cannot do that twice: they carry
// FIXED serials, so the first upload creates the units and every upload after
// it flags duplicate_device_serial_existing_unit and drops the rows into the
// intake exceptions queue. That is correct ingest behaviour and a useless
// demo. This generates fresh serials per click instead, so "upload the sample
// file" is repeatable without reseeding the database.
//
// WHAT MAKES A FILE PASS (services/fulfillment/src/device-inventory-adapter.ts,
// the Workflow A FROZEN rule of the 12 Aug 2026 walkthrough, re-ruled 13 Aug):
//   1. The header must carry a `Device ID` column, or the whole file is
//      rejected structurally. `Sim No` and `Device QR` are optional
//      pass-through values.
//   2. The only per-row check is that Device ID is not blank. There is NO
//      format rule; the old digit-band patterns were deliberately removed,
//      not widened.
//   3. Duplicates are the real gate downstream (services/fulfillment/src/intake.ts):
//      a serial already on a unit flags duplicate_device_serial_existing_unit
//      and creates nothing, and a repeated ICCID flags duplicate_sim_no_* and
//      stores the device with sim_no NULL. So BOTH values have to be new for a
//      row to land clean, which is the whole job of the generator below.
//
// This file holds no credential, no role, no auth bridge and no server call.
// It is a pure string builder, which is why it does not trip the
// no-demo-bridge guard (apps/ops-portal/test/integration/no-demo-bridge.test.ts).

import { csvLine } from '../../lib/csv.js'

/** Header, in FR-01a sheet order. Mirrors DEVICE_INVENTORY_COLUMNS. */
const HEADER = ['Device ID', 'Sim No', 'Device QR'] as const

/** Rows per download, matching the checked-in 4-devices-demo.csv. */
export const SAMPLE_ROW_COUNT = 6

export interface SampleInventoryFile {
  filename: string
  csv: string
  deviceIds: string[]
}

function digits(n: number, width: number): string {
  return String(n).padStart(width, '0').slice(-width)
}

/**
 * A 13-digit Device ID that is new on every call.
 *
 * Shape: `9` + 8 clock digits + 2 random digits + 2 row digits. The clock
 * digits are the low 8 of the epoch millisecond, which do not repeat inside a
 * 27 hour window, and the 2 random digits make a same-millisecond repeat
 * (impossible by hand, cheap to guard anyway) a 1-in-100 event rather than a
 * certainty. The leading `9` keeps generated serials clear of the real CWD
 * ranges, and the 999000000xxxx band the checked-in demo assets use is not
 * reachable from here because positions 2 to 9 are a clock reading.
 */
function deviceIdFor(runMs: number, runSalt: number, rowIndex: number): string {
  return `9${digits(runMs, 8)}${digits(runSalt, 2)}${digits(rowIndex, 2)}`
}

/**
 * A 20-digit ICCID DERIVED from the Device ID, so uniqueness comes for free:
 * distinct serials cannot produce a colliding Sim No, which is what keeps the
 * duplicate_sim_no_* path unreachable for a generated file.
 */
function simNoFor(deviceId: string, rowIndex: number): string {
  return `8991${deviceId}${digits(rowIndex, 3)}`
}

/**
 * The Device QR blob, matching the real sheet: a JSON object whose `DI` key
 * mirrors the Device ID (BRD Annexure E). It is carried as an opaque
 * pass-through value; the adapter never parses the serial back out of it.
 */
function deviceQrFor(deviceId: string, dom: string): string {
  return `{"DI":${deviceId},"DOM":"${dom}"}`
}

/**
 * Builds one passing device-inventory file. `now` and `salt` are injected so a
 * test can pin the output; production callers pass nothing and get a fresh
 * file per click.
 */
export function buildSampleInventoryFile(
  now: Date = new Date(),
  salt: number = Math.floor(Math.random() * 100),
): SampleInventoryFile {
  const runMs = now.getTime()
  const dom = now.toISOString().slice(0, 10)

  const deviceIds: string[] = []
  const lines: string[] = [HEADER.join(',')]

  for (let i = 1; i <= SAMPLE_ROW_COUNT; i += 1) {
    const deviceId = deviceIdFor(runMs, salt, i)
    deviceIds.push(deviceId)
    lines.push(csvLine([deviceId, simNoFor(deviceId, i), deviceQrFor(deviceId, dom)]))
  }

  // A trailing newline: some sheet tools drop the last row without one.
  return {
    filename: `sample-inventory-${dom}-${digits(runMs, 6)}${digits(salt, 2)}.csv`,
    csv: `${lines.join('\n')}\n`,
    deviceIds,
  }
}
