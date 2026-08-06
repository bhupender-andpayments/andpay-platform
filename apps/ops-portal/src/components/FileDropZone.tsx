import { useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { Button } from '@/components/ui/button'

// The shared file target for every upload surface in the console (bank, damage,
// device inventory). It replaces the bare `<input type="file">` those pages used,
// which gave the operator no drop target, no confirmation of WHAT was staged, and
// no way to change their mind short of re-picking.
//
// Three states, and they are the whole design: an idle dashed target, an
// accent-washed "release" state while a file is over it, and a solid card once a
// file is staged. The accent (the one loud color in the token set) is spent only
// on the drag state, which is the single moment feedback has to be unmissable.
//
// The real <input> is kept, focusable and still associated with the page's own
// <label htmlFor>, rather than replaced by a click handler: that keeps the
// control reachable by keyboard and assistive tech, and keeps it addressable as
// a file input by tests and by the browser's own file dialog.
//
// Validation deliberately does NOT live here. The page owns it (the 5 MiB cap
// lives next to the upload call), so this component reports a pick and nothing
// more, and one rule cannot drift between the pages.

const ACCEPT = '.csv,text/csv,.xlsx'

// Sizes read as data, so they get the mono face and a fixed precision rather
// than a chatty approximation.
//
// NOT exported: a module that exports both a component and a plain function
// breaks react-refresh, which then invalidates the whole module on every edit
// ("Could not Fast Refresh") instead of hot-swapping it. That is what left the
// dev page blank after a run of edits here. Export it from a separate module if
// another file ever needs it.
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KB`
  return `${(kib / 1024).toFixed(1)} MB`
}

function fileKind(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? 'file' : name.slice(dot + 1).toLowerCase()
}

export function FileDropZone({
  id,
  file,
  onPick,
  disabled = false,
  accept = ACCEPT,
  constraint = 'CSV or XLSX, max 5 MiB',
  expects,
}: {
  id: string
  file: File | null
  onPick: (file: File | null) => void
  disabled?: boolean
  accept?: string
  constraint?: string
  // The exact column headers the sheet must carry, shown BEFORE the upload.
  // This is the contract the operator is being held to, so it belongs on the
  // control rather than only in a rejection message: not knowing it is the
  // whole reason a correct file was ever rejected in the first place. Pass it
  // only where the canonical list is known; never guess a column name.
  expects?: readonly string[]
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  function handleChange(e: ChangeEvent<HTMLInputElement>): void {
    const picked = e.target.files?.[0]
    // Clearing the value lets the same filename be picked again after a failed
    // attempt, which otherwise fires no change event at all.
    e.target.value = ''
    onPick(picked ?? null)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    const dropped = e.dataTransfer.files?.[0]
    if (dropped !== undefined) onPick(dropped)
  }

  // dragover must be prevented on every tick or the browser navigates to the
  // file instead of letting the drop land.
  function handleDragOver(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    if (!disabled) setDragging(true)
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>): void {
    // Only clear when the pointer leaves the zone itself, not when it crosses
    // between the zone's own children.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragging(false)
  }

  const zoneTone = dragging
    ? 'border-primary bg-primary/10'
    : 'border-line-strong bg-surface-2 hover:border-brand/40 hover:bg-surface-3'

  return (
    <div>
      {/* Visually hidden but present and focusable: the page's label points here. */}
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={handleChange}
        className="sr-only"
      />

      {file === null ? (
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          className={[
            'flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-6 text-center',
            'transition-colors duration-150 motion-reduce:transition-none',
            disabled ? 'cursor-not-allowed opacity-60' : '',
            zoneTone,
          ].join(' ')}
        >
          {dragging ? (
            <p className="text-sm font-semibold text-primary">Release to attach</p>
          ) : (
            <>
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-ink">Drop your file here</p>
                <p className="font-mono text-xs text-subtle">{constraint}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => inputRef.current?.click()}
              >
                Choose file
              </Button>
              {expects !== undefined && expects.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Required columns:{' '}
                  {expects.map((c, i) => (
                    <span key={c}>
                      {i > 0 && <span className="text-subtle">, </span>}
                      <span className="font-mono text-ink">{c}</span>
                    </span>
                  ))}
                </p>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-sm">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-primary/10 font-mono text-[10px] font-semibold uppercase text-primary"
          >
            {fileKind(file.name)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-[13px] text-ink" title={file.name}>
              {file.name}
            </p>
            <p className="text-xs text-subtle">{formatFileSize(file.size)}, ready to upload</p>
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            className="shrink-0 rounded-sm text-[13px] font-medium text-brand underline decoration-brand/30 underline-offset-2 hover:decoration-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed"
          >
            Replace
          </button>
          <button
            type="button"
            aria-label="Remove file"
            disabled={disabled}
            onClick={() => onPick(null)}
            className="shrink-0 rounded-sm px-1 text-base leading-none text-subtle hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed"
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
