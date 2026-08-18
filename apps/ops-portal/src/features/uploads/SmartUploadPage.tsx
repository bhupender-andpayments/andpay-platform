// Task 10: the dedicated smart-upload page. One large dropzone, no kind
// picked up front. Decided 2026-08-18: this is its own page, not a card
// bolted onto the old Uploads landing, and /uploads redirects straight here
// (UploadsPage.tsx), because an operator with a file in hand should never
// have to know its kind before they can start.
//
// The file is never previewed or committed here: it is SNIFFED (a
// header-only, no-Idempotency-Key read, Task 3/4) and then handed to the
// page that owns that kind via the staged-file handoff (Task 9). This page's
// whole job ends the moment the right page has the file.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { FileDropZone } from '../../components/FileDropZone.js'
import { PageHeader, ErrorNote, InfoNote } from '../../ui/primitives.js'
import { useToast } from '../../ui/Toast.js'
import { useAuth } from '../../auth/AuthContext.js'
import { stageFile, takeStagedFile } from '../../lib/stagedFile.js'
import { sniffUpload, uploadFileRejection, type SniffKind } from '../../api/endpoints.js'

// Where a single, unambiguous candidate lands. `unit-status` is deliberately
// absent: there is no dedicated page for it today (the inventory device flow
// is the closest thing), so it is never auto-navigated, single candidate or
// not.
const ROUTE_BY_KIND: Partial<Record<SniffKind, string>> = {
  'return-sheet': '/uploads/return',
  'courier-status': '/uploads/courier-status',
  activation: '/uploads/activation',
  bank: '/uploads/bank',
  'device-inventory': '/inventory/upload',
}

const TOAST_BY_KIND: Record<SniffKind, string> = {
  'return-sheet': 'Detected a return sheet',
  'courier-status': 'Detected a courier status file',
  activation: 'Detected a CWD activation file',
  bank: 'Detected a bank request file',
  'device-inventory': 'Detected a device inventory file',
  'unit-status': 'Detected a device status file',
}

// The label on each choice button when more than one kind matches (or the
// one kind that matches has no dedicated page). Named for what the operator
// holds, not the internal sniff vocabulary.
const CHOICE_LABEL: Record<SniffKind, string> = {
  'return-sheet': 'Print vendor return sheet',
  'courier-status': 'Courier status file',
  activation: 'Activation results from CWD',
  bank: 'Bank request file',
  'device-inventory': 'Device inventory file',
  'unit-status': 'Device status file',
}

const KIND_LINKS: ReadonlyArray<{ label: string; to: string; description: string }> = [
  { label: 'Bank file', to: '/uploads/bank', description: 'New soundbox requests from the bank.' },
  {
    label: 'Return sheet',
    to: '/uploads/return',
    description: 'The print vendor return with Device ID and AWB filled in.',
  },
  { label: 'Courier status', to: '/uploads/courier-status', description: 'Batch delivery updates from the courier.' },
  { label: 'Activation file', to: '/uploads/activation', description: 'The activation outcomes CWD returns.' },
]

const UNKNOWN_FORMAT_ERROR =
  'Could not tell what kind of file this is from its header row. Expected one of: a bank request file, a print vendor return sheet, a courier status file, or a CWD activation file.'

export function SmartUploadPage() {
  const { client } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [sniffing, setSniffing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set only in the collision case: more than one candidate, or the single
  // candidate has nowhere to land. Cleared the moment a new file is picked.
  const [choices, setChoices] = useState<SniffKind[] | null>(null)
  // Set once the operator explicitly picks the no-page kind from the choices,
  // so its explanation shows without navigating anywhere.
  const [infoKind, setInfoKind] = useState<SniffKind | null>(null)

  // Set true the instant `land()` hands a file off, so the unmount cleanup
  // below can tell "this file was legitimately staged for the page we are
  // navigating to" from "this page is going away with a file still sitting
  // in the module-level slot" (a drop that never landed: back navigation,
  // an unrelated nav click, the tab closing before a candidate was chosen).
  const landedRef = useRef(false)

  // A drop that never lands must not leak into whatever upload page mounts
  // next and auto-fire against a file the operator never meant for it.
  useEffect(() => {
    return () => {
      if (!landedRef.current) takeStagedFile()
    }
  }, [])

  const land = useCallback(
    (picked: File, kind: SniffKind): void => {
      landedRef.current = true
      stageFile(picked)
      toast(TOAST_BY_KIND[kind])
      navigate(ROUTE_BY_KIND[kind]!)
    },
    [navigate, toast],
  )

  const choose = useCallback(
    (kind: SniffKind): void => {
      if (file === null) return
      if (ROUTE_BY_KIND[kind] === undefined) {
        setInfoKind(kind)
        return
      }
      land(file, kind)
    },
    [file, land],
  )

  const handleFile = useCallback(
    async (picked: File | null): Promise<void> => {
      setError(null)
      setChoices(null)
      setInfoKind(null)
      if (picked === null) {
        setFile(null)
        return
      }
      const rejection = uploadFileRejection(picked)
      if (rejection !== null) {
        setFile(null)
        setError(rejection)
        return
      }
      setFile(picked)
      setSniffing(true)
      try {
        const { candidates } = await sniffUpload(client, picked)
        if (candidates.length === 0) {
          setError(UNKNOWN_FORMAT_ERROR)
          return
        }
        const only = candidates.length === 1 ? candidates[0] : undefined
        if (only !== undefined && ROUTE_BY_KIND[only] !== undefined) {
          land(picked, only)
          return
        }
        // Either more than one candidate, or the single candidate has no
        // dedicated page: both are a choice for the operator, not a guess.
        setChoices(candidates)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to read the file.')
      } finally {
        setSniffing(false)
      }
    },
    [client, land],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Upload a file"
        description="Drop any bank, vendor, courier or CWD sheet. We read the header row and take you to the right upload."
      />

      <Card>
        <CardHeader>
          <CardTitle>File</CardTitle>
          <CardDescription>Nothing is written by dropping a file here. It is only read to tell what it is.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="smart-upload-file">File to upload</Label>
            <FileDropZone
              id="smart-upload-file"
              file={file}
              onPick={(f) => {
                void handleFile(f)
              }}
              disabled={sniffing}
            />
          </div>

          {sniffing && (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Reading the file…
            </p>
          )}

          {error !== null && <ErrorNote>{error}</ErrorNote>}

          {choices !== null && (
            <div className="space-y-2">
              <p className="text-sm font-medium">This file matches more than one kind. Which is it?</p>
              <div className="flex flex-wrap gap-2">
                {choices.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => choose(kind)}
                    className="rounded-lg border border-border bg-card px-3.5 py-2 text-[13px] font-medium text-foreground shadow-sm hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {CHOICE_LABEL[kind]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {infoKind !== null && (
            <InfoNote>
              There is no dedicated page for a device status file yet. Use the{' '}
              <Link className="underline" to="/inventory/upload">
                inventory device flow
              </Link>{' '}
              instead.
            </InfoNote>
          )}
        </CardContent>
      </Card>

      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Know the kind already?
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {KIND_LINKS.map((k) => (
            <Link
              key={k.to}
              to={k.to}
              className="rounded-4xl transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:-translate-y-0.5"
            >
              <Card className="h-full">
                <CardHeader>
                  <CardTitle className="text-base">{k.label}</CardTitle>
                  <CardDescription>{k.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
