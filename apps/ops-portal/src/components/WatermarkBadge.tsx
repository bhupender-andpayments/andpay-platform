import { fmtDateTime } from '../ui/format.js'

// Renders the D100 analytics watermark (carried in the tile/report read JSON
// body): a plain marker of how fresh the served data is, never a live
// "as of now" claim computed client-side. `null` means the response carried no
// watermark; shown as a neutral state, not an error. The raw ISO value is kept
// in the title attribute for precision while the pill shows a humane time.
export function WatermarkBadge({ watermark }: { watermark: string | null }) {
  if (watermark === null) {
    return <span className="pill pill-neutral">No watermark</span>
  }
  return (
    <span className="pill pill-neutral" title={watermark}>
      Updated {fmtDateTime(watermark)}
    </span>
  )
}
