import { Card } from '../../ui/primitives.js'
import { fmtNumber } from '../../ui/format.js'
import type { PoolEntryRow } from '../../api/endpoints.js'
import { IconCheck } from '../../ui/icons.js'

// What the next batch would contain, summarised beside the pool it summarises.
//
// EVERY FIGURE IS DERIVED IN TYPESCRIPT from rows the page already fetched for
// display, which is the same posture BatchablePools states for its own counts:
// test/architecture.test.ts forbids aggregates in ops-read.ts, because the ops
// portal is a row-level queue surface and aggregation belongs to the analytics
// rail. Honest at today's volumes; if the pool ever outgrows what is reasonable
// to send to a browser the answer is an analytics number, not a GROUP BY in the
// read module.
//
// WHAT IS DELIBERATELY ABSENT: an "estimated pages (PDF)" figure. Page count
// depends on the bound print vendor's imposition (ONE_PER_PAGE vs GRID_3X2),
// and no vendor is bound until the batch forms, so any number here would be
// invented rather than derived. The batch's own page shows the real count once
// there is one.

export interface PoolSummary {
  records: number
  merchants: number
  banks: number
  soundboxes: number
  standees: number
  stickers: number
}

export function summarisePool(rows: readonly PoolEntryRow[]): PoolSummary {
  return {
    records: rows.length,
    merchants: new Set(rows.map((r) => r.merchantDisplayName)).size,
    // Counted on the AGGREGATOR CODE, never the display name. D7 leaves
    // bank_display_name as the partner ("GSCB") on every row, so counting names
    // reports 1 bank for a pool spanning 19 aggregators. groupBatchablePools
    // carries the same note for the same reason.
    banks: new Set(rows.map((r) => r.bankReferenceCode)).size,
    soundboxes: rows.filter((r) => r.soundbox).length,
    standees: rows.reduce((n, r) => n + r.standeeCount, 0),
    stickers: rows.reduce((n, r) => n + r.stickerCount, 0),
  }
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      <span className="num text-[13px] font-semibold text-foreground">{value}</span>
    </div>
  )
}

export function BatchPreviewCard({
  rows,
  minLotSize,
}: {
  rows: readonly PoolEntryRow[]
  /** The SAME resolved rule the Auto-trigger card below prints, so the two
   *  cannot disagree about the threshold on one screen. */
  minLotSize: number | null
}) {
  const s = summarisePool(rows)
  const meets = minLotSize !== null && s.records >= minLotSize
  // Clamped at both ends: a pool past its lot size must not overflow the track,
  // and a pool with a single record must not round down to an empty bar and
  // read as nothing pooled.
  const pct =
    minLotSize === null || minLotSize === 0
      ? 0
      : Math.min(100, Math.max(s.records > 0 ? 4 : 0, (s.records / minLotSize) * 100))

  return (
    // gap-0 because the shadcn Card is a flex column with a 24px gap between
    // every child, which was being ADDED to the mt-* below it: the title, its
    // own subtitle and the list were each a full card-spacing apart and the
    // card read as four unrelated blocks. The margins here are the spacing.
    <Card className="gap-0 p-4">
      <p className="text-sm font-semibold text-foreground">Batch preview</p>
      <p className="mt-0.5 text-[12px] text-muted-foreground">What the next batch would contain.</p>

      <div className="mt-2.5 divide-y divide-border/60">
        <Line label="Records" value={fmtNumber(s.records)} />
        <Line label="Merchants" value={fmtNumber(s.merchants)} />
        <Line label={s.banks === 1 ? 'Bank' : 'Banks'} value={fmtNumber(s.banks)} />
        <Line label="Soundboxes" value={fmtNumber(s.soundboxes)} />
        <Line label="Standees" value={fmtNumber(s.standees)} />
        <Line label="Stickers" value={fmtNumber(s.stickers)} />
      </div>

      {/* The lot-size verdict, stated rather than left to be worked out from
          the two numbers. Silent when no lot size is configured: a tick or a
          cross against a threshold nobody set would be a claim we cannot make.
          The bar below it is the same fact drawn rather than read, which is
          the part the eye gets in one glance. */}
      {minLotSize !== null && (
        <div
          className={`mt-3 rounded-xl px-3 py-2.5 text-[12.5px] font-medium ${
            meets
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span>
              {meets
                ? `Meets minimum lot size (${fmtNumber(minLotSize)})`
                : `${fmtNumber(s.records)} of ${fmtNumber(minLotSize)} toward the minimum lot`}
            </span>
            {meets && <IconCheck width={15} height={15} aria-hidden="true" />}
          </div>
          {/* aria-hidden, and deliberately: the sentence directly above already
              carries both numbers, so a screen reader announcing the same
              progress twice would be noise, not access. */}
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${
                meets ? 'bg-emerald-500' : 'bg-primary'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
    </Card>
  )
}
