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
export interface UploadResultBreakdown {
  accepted?: number
  replaced?: number
  quarantined?: number
  flagged?: number
  invalid?: number
  duplicate?: number
}

// Renders task 13's upload result breakdown with a link to the quarantine
// queue (task 11's /queues route) so an operator can go straight to the rows
// that failed.
export function PerRowErrors({ result }: { result: UploadResultBreakdown }) {
  return (
    <dl className="flex flex-wrap gap-6 text-sm">
      {result.accepted !== undefined && (
        <div>
          <dt className="text-subtle">Accepted</dt>
          <dd className="text-lg font-semibold text-ink">{result.accepted}</dd>
        </div>
      )}
      {result.replaced !== undefined && (
        <div>
          <dt className="text-subtle">Replaced</dt>
          <dd className="text-lg font-semibold text-ink">{result.replaced}</dd>
        </div>
      )}
      {result.quarantined !== undefined && (
        <div>
          <dt className="text-subtle">Quarantined</dt>
          <dd className="text-lg font-semibold text-amber-700">
            {result.quarantined}
            {result.quarantined > 0 && (
              <>
                {' '}
                <Link to="/queues" className="text-sm font-medium text-brand underline hover:text-brand-strong">
                  view in quarantine queue
                </Link>
              </>
            )}
          </dd>
        </div>
      )}
      {result.flagged !== undefined && (
        <div>
          <dt className="text-subtle">Flagged</dt>
          <dd className="text-lg font-semibold text-amber-700">
            {result.flagged}
            {result.flagged > 0 && (
              <>
                {' '}
                <Link to="/queues" className="text-sm font-medium text-brand underline hover:text-brand-strong">
                  view in intake exceptions
                </Link>
              </>
            )}
          </dd>
        </div>
      )}
      {result.invalid !== undefined && (
        <div>
          <dt className="text-subtle">Invalid</dt>
          <dd className="text-lg font-semibold text-ink">{result.invalid}</dd>
        </div>
      )}
      {result.duplicate !== undefined && (
        <div>
          <dt className="text-subtle">Duplicate</dt>
          <dd className="text-lg font-semibold text-ink">{result.duplicate}</dd>
        </div>
      )}
    </dl>
  )
}
