// A module-level handoff, not a store: the smart upload page (Task 10) calls
// stageFile(file) then navigates to one of the four upload pages, and that
// page's mount effect calls takeStagedFile() and runs its own handleFile as if
// the file had been dropped there directly. take() clears on read, so a
// refresh loses it by design: this is a same-tick handoff, not persistence.

let staged: File | null = null

export function stageFile(f: File): void {
  staged = f
}

export function takeStagedFile(): File | null {
  const f = staged
  staged = null
  return f
}
