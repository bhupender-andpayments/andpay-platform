// Renders the D100 analytics watermark (the `x-analytics-watermark` response
// header the ops-edge tile/report reads carry): a plain marker of how fresh
// the served data is, never a live "as of now" claim computed client-side.
// `null` means the response carried no watermark; that is shown as a
// neutral state, not an error.
export function WatermarkBadge({ watermark }: { watermark: string | null }) {
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
      {watermark === null ? 'no watermark' : `as of ${watermark}`}
    </span>
  )
}
