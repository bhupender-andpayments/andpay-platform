import { Link } from 'react-router-dom'

// The per-row outcome breakdown returned by the ops upload endpoints:
// POST /ops/uploads/bank/commit             -> {accepted,quarantined,duplicate}
// POST /ops/uploads/device-inventory        -> {accepted,flagged,invalid}
// (The damage commit route that used to sit here is gone: D-25 ended damage
// file ingestion, so `replaced` no longer arrives from any endpoint.)
// `quarantined` (bank) and `flagged` (device-inventory) both name a
// count of rows that landed in a review queue rather than committing clean;
// they route to different queues (quarantine vs intake exceptions, both
// under task 11's /queues route) so each renders its own labeled link.
// `invalid` (device-inventory only) never lands in any queue: FR-01a rows
// missing a mandatory field are reported directly in the response and never
// ingested at all, so it renders as a plain count, no link.
//
// ONLY DEVICE INVENTORY RENDERS THIS as of 17 Aug 2026. The bank ingest page
// used to, and its redesign ended with buttons only under its two tables: each
// table's own header states its count, so a summary beneath them restated the
// screen. `DeviceInventoryUploadPage` is the single remaining caller.
//
// THE BANK-ONLY FIELDS BELOW ARE RECEIVED AND DELIBERATELY NOT SHOWN, which is
// a product decision and not an oversight, so nobody has to wonder. Three of
// them have no other surface anywhere in the portal now:
//   - `qrMalformed` (D-8) counted the rows the BANK sent with an HTML-escaped
//     QR separator, a known GSCB export defect fulfillment corrects at the
//     artifact boundary. The D4 ruling ends "This is a compensating control
//     for a bank-side bug, not a fix. GSCB should still be told", and this
//     count was what made telling them possible.
//   - `duplicateVpa` / `duplicateVpaHeld` / `duplicateMobile` (D-2) were the
//     review signals for a returning merchant and for two merchants sharing a
//     contact number.
// The commit response still carries all of them, so restoring a surface is a
// rendering change and nothing more.
export interface UploadResultBreakdown {
  accepted?: number
  quarantined?: number
  flagged?: number
  invalid?: number
  duplicate?: number
  qrMalformed?: number
  duplicateVpa?: number
  duplicateVpaHeld?: { rowNo: number; duplicateOf: { reference: string; merchantDisplayName: string | null } }[]
  duplicateMobile?: number
}

// Renders task 13's upload result breakdown with a link to the review queue
// (task 11's /queues route) so an operator can go straight to the rows that
// need them.
export function PerRowErrors({ result }: { result: UploadResultBreakdown }) {
  return (
    <dl className="flex flex-wrap gap-6 text-sm">
      {result.accepted !== undefined && (
        <div>
          <dt className="text-muted-foreground">Accepted</dt>
          <dd className="text-lg font-semibold text-foreground">{result.accepted}</dd>
        </div>
      )}
      {result.quarantined !== undefined && (
        <div>
          <dt className="text-muted-foreground">Held for review</dt>
          <dd className="text-lg font-semibold text-amber-700">
            {result.quarantined}
            {result.quarantined > 0 && (
              <>
                {' '}
                <Link to="/queues/quarantine" className="text-sm font-medium text-primary underline hover:text-primary/80">
                  view in quarantine queue
                </Link>
              </>
            )}
          </dd>
        </div>
      )}
      {result.flagged !== undefined && (
        <div>
          <dt className="text-muted-foreground">Flagged</dt>
          <dd className="text-lg font-semibold text-amber-700">
            {result.flagged}
            {result.flagged > 0 && (
              <>
                {' '}
                <Link to="/queues/intake" className="text-sm font-medium text-primary underline hover:text-primary/80">
                  view in intake exceptions
                </Link>
              </>
            )}
          </dd>
        </div>
      )}
      {result.invalid !== undefined && (
        <div>
          <dt className="text-muted-foreground">Invalid</dt>
          <dd className="text-lg font-semibold text-foreground">{result.invalid}</dd>
        </div>
      )}
    </dl>
  )
}
