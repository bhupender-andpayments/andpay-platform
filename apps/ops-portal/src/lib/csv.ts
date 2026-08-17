// RFC 4180 cell quoting, shared by the sample-file generators.
//
// It lives here rather than in either generator because both build a CSV a real
// parser has to read back, and two copies of an escaper is how one of them
// quietly stops quoting the case the other learned about. It must NOT be
// exported from a module that also exports a React component (see lib/saveBlob.ts
// for the react-refresh reason).
export function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function csvLine(cells: readonly string[]): string {
  return cells.map(csvCell).join(',')
}
