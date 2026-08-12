import { Link } from 'react-router-dom'

// The per-row outcome breakdown returned by the ops upload endpoints:
// POST /ops/uploads/bank/commit             -> {accepted,quarantined,duplicate}
// POST /ops/uploads/damage/commit           -> {replaced,quarantined,duplicate}
// POST /ops/uploads/device-inventory        -> {accepted,flagged,invalid}
// `quarantined` (bank/damage) and `flagged` (device-inventory) both name a
// count of rows that landed in a review queue rather than committing clean;
// they route to different queues (quarantine vs intake exceptions, both
// under task 11's /queues route) so each renders its own labeled link.
// `invalid` (device-inventory only) never lands in any queue: FR-01a rows
// missing a mandatory field are reported directly in the response and never
// ingested at all, so it renders as a plain count, no link.
// `qrMalformed` (bank commit only, D-8) is NOT an outcome count like the others:
// those rows ingested normally. It reports how many rows the BANK sent with an
// HTML-escaped QR separator, a known GSCB export defect that fulfillment
// corrects automatically at the artifact boundary. It is surfaced because the D4
// ruling ends "This is a compensating control for a bank-side bug, not a fix.
// GSCB should still be told", and there was previously no number to tell them.
// Rendered separately and never as a failure, so an operator is not trained to
// read a clean upload as broken.
export interface UploadResultBreakdown {
  accepted?: number
  replaced?: number
  quarantined?: number
  flagged?: number
  invalid?: number
  duplicate?: number
  qrMalformed?: number
  // `duplicateVpa` (bank commit only, D-2) reports how many rows carried a VPA
  // already seen, in this file or an earlier upload.
  //
  // These rows are QUARANTINED (ruled 2026-08-11, superseding the earlier
  // flag-only posture). This paragraph used to read "accepted, not held", and
  // kept saying it for a while after the server started holding them, which is
  // the worst possible failure for a results panel: an operator who re-uploaded
  // a file saw a red "nothing was committed" toast and a panel underneath
  // telling them the rows went through. Those rows are ALREADY COUNTED in
  // `quarantined` above; this only names the reason.
  duplicateVpa?: number
  // `duplicateMobile` is a DIFFERENT signal from duplicateVpa and gets its own
  // notice: a repeat VPA is one merchant returning, a repeat mobile on another
  // VPA is two merchants sharing a contact number. Only the second is news.
  duplicateMobile?: number
}

// Renders task 13's upload result breakdown with a link to the quarantine
// queue (task 11's /queues route) so an operator can go straight to the rows
// that failed.
export function PerRowErrors({ result }: { result: UploadResultBreakdown }) {
  return (
    <>
      <dl className="flex flex-wrap gap-6 text-sm">
      {result.accepted !== undefined && (
        <div>
          <dt className="text-muted-foreground">Accepted</dt>
          <dd className="text-lg font-semibold text-foreground">{result.accepted}</dd>
        </div>
      )}
      {result.replaced !== undefined && (
        <div>
          <dt className="text-muted-foreground">Replaced</dt>
          <dd className="text-lg font-semibold text-foreground">{result.replaced}</dd>
        </div>
      )}
      {result.quarantined !== undefined && (
        <div>
          <dt className="text-muted-foreground">Quarantined</dt>
          <dd className="text-lg font-semibold text-amber-700">
            {result.quarantined}
            {result.quarantined > 0 && (
              <>
                {' '}
                {/* Deep-linked to the TAB that holds these rows. A bare /queues
                    landed on whichever tab the page defaulted to, which for an
                    intake-exception link was the wrong one. */}
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
      {result.duplicate !== undefined && (
        <div>
          <dt className="text-muted-foreground">Duplicate</dt>
          <dd className="text-lg font-semibold text-foreground">{result.duplicate}</dd>
        </div>
      )}
      </dl>
      {result.qrMalformed !== undefined && result.qrMalformed > 0 && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="font-semibold">{`${result.qrMalformed} of them`}</span>
          {' arrived from the bank with a malformed QR separator. They were '}
          <span className="font-semibold">corrected automatically</span>
          {' before anything was printed, so no action is needed here. Worth raising with the bank so their export is fixed at source.'}
        </p>
      )}
      {result.duplicateVpa !== undefined && result.duplicateVpa > 0 && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="font-semibold">{`${result.duplicateVpa} row(s)`}</span>
          {' repeat a UPI ID already in the system, from this file or an earlier upload. They were '}
          <span className="font-semibold">held in quarantine, not committed</span>
          {', so a repeat cannot reach a print run unreviewed. A repeat is often a genuine additional soundbox for a merchant we already have: '}
          <Link to="/queues/quarantine" className="font-medium text-primary underline hover:text-primary/80">
            open Queues
          </Link>
          {' to accept or reject each one.'}
        </p>
      )}
      {result.duplicateMobile !== undefined && result.duplicateMobile > 0 && (
        <p className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <span className="font-semibold">{`${result.duplicateMobile} of them`}</span>
          {' share a mobile number with a '}
          <span className="font-semibold">different merchant</span>
          {'. They were accepted, not held. Often one owner with two shops, sometimes a typo in the contact number, so worth checking.'}
        </p>
      )}
    </>
  )
}
