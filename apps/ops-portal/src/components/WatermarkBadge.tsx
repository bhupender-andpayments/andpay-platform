import { fmtDateTime } from '../ui/format.js'
// Renders the D100 analytics watermark (the `x-analytics-watermark` response
// header the ops-edge tile/report reads carry): a plain marker of how fresh
// the served data is, never a live "as of now" claim computed client-side.
// `null` means the response carried no watermark; that is shown as a
// neutral state, not an error.
export function WatermarkBadge({ watermark }: { watermark: string | null }) {
  // Rendered in the reader's locale rather than as a raw ISO string. The exact
  // instant stays available on hover, so nothing is lost for an operator who
  // needs to quote it precisely.
  return (
    <span
      className="inline-flex items-center rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
      title={watermark ?? undefined}
    >
      {watermark === null ? 'no watermark' : `as of ${fmtDateTime(watermark)}`}
    </span>
  )
}
