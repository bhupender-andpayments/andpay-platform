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

function StatBox({ label, value, tone }: { label: string; value: number; tone: 'good' | 'warn' | 'muted' }) {
  const toneClass = tone === 'good' ? 'text-[#15803d]' : tone === 'warn' ? 'text-[#a15c07]' : 'text-ink'
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <dt className="text-[12px] font-medium text-muted">{label}</dt>
      <dd className={`num mt-1 text-2xl font-semibold ${toneClass}`}>{value}</dd>
    </div>
  )
}

// Task 10 upload result breakdown with a link to the quarantine queue so an
// operator can jump straight to the rows that failed validation.
export function PerRowErrors({ result }: { result: UploadResultBreakdown }) {
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {result.accepted !== undefined && <StatBox label="Accepted" value={result.accepted} tone="good" />}
        {result.replaced !== undefined && <StatBox label="Replaced" value={result.replaced} tone="good" />}
        <StatBox label="Quarantined" value={result.quarantined} tone={result.quarantined > 0 ? 'warn' : 'muted'} />
        {result.duplicate !== undefined && <StatBox label="Duplicate" value={result.duplicate} tone="muted" />}
      </dl>
      {result.quarantined > 0 && (
        <Link
          to="/queues"
          className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:text-brand-strong hover:underline"
        >
          view in quarantine queue →
        </Link>
      )}
    </div>
  )
}
