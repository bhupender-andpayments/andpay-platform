import { Link } from 'react-router-dom'

// The per-row outcome breakdown returned by the two ops upload endpoints:
// POST /ops/uploads/bank -> {accepted,quarantined,duplicate}
// POST /ops/uploads/damage -> {replaced,quarantined,duplicate}
// Both share `quarantined`; only one of `accepted`/`replaced` applies per
// upload kind, so both are optional here.
export interface UploadResultBreakdown {
  accepted?: number
  replaced?: number
  quarantined: number
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
          <dt className="text-slate-500">Accepted</dt>
          <dd className="text-lg font-semibold text-slate-900">{result.accepted}</dd>
        </div>
      )}
      {result.replaced !== undefined && (
        <div>
          <dt className="text-slate-500">Replaced</dt>
          <dd className="text-lg font-semibold text-slate-900">{result.replaced}</dd>
        </div>
      )}
      <div>
        <dt className="text-slate-500">Quarantined</dt>
        <dd className="text-lg font-semibold text-amber-700">
          {result.quarantined}
          {result.quarantined > 0 && (
            <>
              {' '}
              <Link to="/queues" className="text-sm font-medium text-blue-600 underline hover:text-blue-800">
                view in quarantine queue
              </Link>
            </>
          )}
        </dd>
      </div>
      {result.duplicate !== undefined && (
        <div>
          <dt className="text-slate-500">Duplicate</dt>
          <dd className="text-lg font-semibold text-slate-900">{result.duplicate}</dd>
        </div>
      )}
    </dl>
  )
}
