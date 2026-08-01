// The client-side Blob download for the CSV/Excel export (Task 10). The CSV
// text has already been fetched via responseType:'text' (a text/csv body is
// not valid JSON, so it never goes through JSON.parse); this just turns it
// into a file the browser downloads. No data is persisted beyond the current
// view (S7): nothing here writes to storage, and the object URL is revoked
// immediately after the click.
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
