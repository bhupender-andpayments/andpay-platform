import type { BatchingConfigRow } from '../../api/endpoints.js'
import { Card, CardBody } from '../../ui/primitives.js'
import { fmtNumber } from '../../ui/format.js'

// The two numbers that decide when a pool becomes a batch on its own
// (BRD FR-033): Minimum Lot Size and Maximum Wait Time. They govern every
// trigger on this page whether or not anybody has customised them, so the page
// states them instead of leaving an operator to go and look them up under Master
// Data, which is the only place they appeared before.
//
// The server's own fallbacks, from services/fulfillment/src/config/pool-config.ts
// DEFAULT_POOL_CFG: what resolvePoolConfig applies when batching_config holds no
// matching row. Restated here ONLY to label them as the platform default; the
// service remains the source of truth and the panel says so with its pill.
const DEFAULT_MIN_LOT = 50
const DEFAULT_MAX_WAIT_SECONDS = 7 * 24 * 3600

export function fmtWait(seconds: number): string {
  if (seconds % 86400 === 0) {
    const d = seconds / 86400
    return `${d} ${d === 1 ? 'day' : 'days'}`
  }
  if (seconds % 3600 === 0) {
    const h = seconds / 3600
    return `${h} ${h === 1 ? 'hour' : 'hours'}`
  }
  return `${seconds} s`
}

/**
 * The effective global rule, plus a count of the scoped overrides that exist.
 *
 * Config precedence in the service is (tenant, program), then tenant, then
 * global, then the code default. Only the GLOBAL row is summarised because this
 * panel sits beside pools belonging to any tenant, and picking one tenant's
 * override to display here would misreport the rule for every other pool on
 * screen. The override count says "there are more specific rules" without
 * pretending to resolve them.
 */
export function resolveGlobalRule(configs: readonly BatchingConfigRow[] | null): {
  minLotSize: number
  maxWaitSeconds: number
  isDefault: boolean
  overrides: number
} {
  const global = configs?.find((c) => c.scope === 'GLOBAL') ?? null
  return {
    minLotSize: global?.minLotSize ?? DEFAULT_MIN_LOT,
    maxWaitSeconds: global?.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS,
    isDefault: global === null,
    overrides: (configs ?? []).filter((c) => c.scope !== 'GLOBAL').length,
  }
}

/**
 * A SIDE PANEL, not a full-width strip: reference information an operator
 * glances at, not the thing they came to the page to do. A real Card now
 * (2026-08-14) rather than a bespoke muted box, so the page runs one visual
 * system; the compact width is what keeps it subordinate.
 */
export function BatchingRules({ configs }: { configs: readonly BatchingConfigRow[] | null }) {
  const rule = resolveGlobalRule(configs)
  return (
    <Card className="h-full">
      <CardBody className="flex h-full flex-col gap-3">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Batching rules</span>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12.5px] text-muted-foreground">Minimum lot</span>
          <span className="num text-base font-semibold tracking-tight">
            {fmtNumber(rule.minLotSize)} requests
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12.5px] text-muted-foreground">Maximum wait</span>
          <span className="num text-base font-semibold tracking-tight">{fmtWait(rule.maxWaitSeconds)}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {rule.isDefault && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">platform default</span>
        )}
        {rule.overrides > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {rule.overrides} override{rule.overrides === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {/* "Requests", not "records", and the distinction is not pedantry: the
          service counts DISTINCT bank requests against the lot size, and one
          request becomes up to two dispatch records. Labelling the threshold in
          records is what made the old progress line overstate how close a pool
          was to batching itself. */}
      <p className="mt-auto text-[11.5px] leading-snug text-muted-foreground">
        A pool batches itself at the lot size, at max wait, or by hand below.
      </p>
      </CardBody>
    </Card>
  )
}
