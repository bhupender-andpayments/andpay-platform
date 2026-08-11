import { Label } from '@/components/ui/label'
import { ErrorNote } from '../../../ui/primitives.js'
import { FileDropZone } from '../../../components/FileDropZone.js'

// Workflow stage 1 (2026-08-11 ruling): the bank upload's drop zone, moved in
// from the old features/uploads/BankUploadPage.tsx as-is. PRESENTATIONAL only:
// the 5 MiB client-side cap, the preview call, and every piece of `useState`
// live on WorkflowPage, which owns `file` / `preview` / `error` and hands them
// down as props plus the `onPick` callback. This component renders what it is
// given and nothing more.
export function UploadStage({ file, previewing, error, onPick }: {
  file: File | null
  previewing: boolean
  error: string | null
  onPick: (f: File | null) => void
}): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="bank-upload-file">Bank request file</Label>
        <FileDropZone id="bank-upload-file" file={file} onPick={onPick} disabled={previewing} />
      </div>

      {error !== null && <ErrorNote>{error}</ErrorNote>}
    </div>
  )
}
