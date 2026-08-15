import { useState } from 'react'
import { fmtNumber } from '../../ui/format.js'

// The Command Center's one chart: dispatches handed to the courier per time
// bucket, with deliveries beside them. Two series, so categorical color:
// chart-1 (the brand amber) for Dispatched, chart-2 (blue) for Delivered -
// the pair passes the palette validator on both surfaces (CVD dE 29.8,
// normal-vision 35.9). The amber sits below 3:1 contrast against the light
// surface, which obligates visible labels: every bar group carries a hover
// tooltip and, when the bucket count leaves room, the dispatched value is
// printed above its bar.
//
// Marks follow the shared grammar: thin bars anchored to the baseline with a
// small rounded data-end, a real gap between the two bars of a group,
// recessive gridlines, text in text tokens (never the series color).

export interface TrendBucket {
  key: string
  /** Short axis label ("13 Aug", "w/c 11 Aug", "Aug 2026"). */
  label: string
  dispatched: number
  delivered: number
}

const H = 200
const PAD_TOP = 18
const PAD_BOTTOM = 26
const PLOT_H = H - PAD_TOP - PAD_BOTTOM

export function TrendChart({ buckets, unitLabel }: { buckets: readonly TrendBucket[]; unitLabel: string }) {
  const [hover, setHover] = useState<number | null>(null)

  if (buckets.length === 0 || buckets.every((b) => b.dispatched === 0 && b.delivered === 0)) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Nothing was dispatched in this range. Widen the dates above to see movement.
      </p>
    )
  }

  const max = Math.max(1, ...buckets.map((b) => Math.max(b.dispatched, b.delivered)))
  // Integer gridlines only: a count axis with fractional ticks reads as noise.
  const step = Math.max(1, Math.ceil(max / 4))
  const ticks: number[] = []
  for (let t = step; t <= max; t += step) ticks.push(t)

  const W = 800
  const PAD_LEFT = 34
  const plotW = W - PAD_LEFT - 8
  const groupW = plotW / buckets.length
  // Two bars per group, 2px apart, and a wider gap between groups.
  const barW = Math.max(3, Math.min(22, groupW * 0.32))
  const y = (v: number): number => PAD_TOP + PLOT_H * (1 - v / max)
  // Label every bucket when they fit; every Nth otherwise, so the axis never
  // collides with itself on a year of months.
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 10))
  const showValues = buckets.length <= 12

  return (
    <div>
      {/* Two series, so a legend is always present. */}
      <div className="mb-2 flex items-center gap-4 text-[12px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-[var(--color-chart-1)]" aria-hidden="true" /> Dispatched
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-[var(--color-chart-2)]" aria-hidden="true" /> Delivered
        </span>
        <span className="ml-auto">per {unitLabel}</span>
      </div>
      <svg viewBox={`0 0 ${String(W)} ${String(H)}`} className="w-full" role="img" aria-label="Dispatches over time">
        {/* Recessive grid: thin lines, muted ink, behind the marks. */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_LEFT} x2={W - 8} y1={y(t)} y2={y(t)} stroke="var(--color-border)" strokeWidth={1} />
            <text x={PAD_LEFT - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--color-muted-foreground)">
              {fmtNumber(t)}
            </text>
          </g>
        ))}
        <line
          x1={PAD_LEFT}
          x2={W - 8}
          y1={PAD_TOP + PLOT_H}
          y2={PAD_TOP + PLOT_H}
          stroke="var(--color-border)"
          strokeWidth={1}
        />

        {buckets.map((b, i) => {
          const cx = PAD_LEFT + groupW * i + groupW / 2
          const x1 = cx - barW - 1
          const x2 = cx + 1
          const dispatchedH = (b.dispatched / max) * PLOT_H
          const deliveredH = (b.delivered / max) * PLOT_H
          return (
            <g
              key={b.key}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              opacity={hover === null || hover === i ? 1 : 0.45}
            >
              {/* An invisible full-height hit target: the mark is thin, the
                  target must not be. */}
              <rect x={PAD_LEFT + groupW * i} y={PAD_TOP} width={groupW} height={PLOT_H} fill="transparent" />
              {b.dispatched > 0 && (
                <rect
                  x={x1}
                  y={y(b.dispatched)}
                  width={barW}
                  height={dispatchedH}
                  rx={Math.min(4, barW / 2)}
                  fill="var(--color-chart-1)"
                />
              )}
              {b.delivered > 0 && (
                <rect
                  x={x2}
                  y={y(b.delivered)}
                  width={barW}
                  height={deliveredH}
                  rx={Math.min(4, barW / 2)}
                  fill="var(--color-chart-2)"
                />
              )}
              {/* The value in ink, never in the series color. */}
              {showValues && b.dispatched > 0 && (
                <text
                  x={x1 + barW / 2}
                  y={y(b.dispatched) - 4}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--color-muted-foreground)"
                  className="num"
                >
                  {fmtNumber(b.dispatched)}
                </text>
              )}
              {i % labelEvery === 0 && (
                <text
                  x={cx}
                  y={H - 8}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--color-muted-foreground)"
                >
                  {b.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {/* The hover readout, in prose under the plot rather than a floating
          tooltip: nothing to position, nothing to clip, and it reads fine on
          touch where hover never fires. */}
      <p className="mt-1 min-h-5 text-[12px] text-muted-foreground" aria-live="polite">
        {hover !== null &&
          `${buckets[hover]!.label}: ${fmtNumber(buckets[hover]!.dispatched)} dispatched, ${fmtNumber(buckets[hover]!.delivered)} delivered`}
      </p>
    </div>
  )
}
