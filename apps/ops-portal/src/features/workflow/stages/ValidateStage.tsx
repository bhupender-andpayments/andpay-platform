import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorNote, StatusPill } from '../../../ui/primitives.js'
import { PerRowErrors } from '../../../components/PerRowErrors.js'
import type { BankPreviewResult, BankCommitResult } from '../../../api/endpoints.js'

// Workflow stage 2 (2026-08-11 ruling): the bank upload's review table and
// commit step, moved in from the old features/uploads/BankUploadPage.tsx and
// merged into ONE stage (the old rail's separate Review and Commit steps, and
// their `confirming` state, are gone: WorkflowRail owns the rail now).
// PRESENTATIONAL only: WorkflowPage owns `preview` / `committing` /
// `commitResult` / `error` and the commit call itself; this component only
// renders what it is handed and calls `onCommit` on click.
export function ValidateStage({ preview, committing, commitResult, error, onCommit }: {
  preview: BankPreviewResult
  committing: boolean
  commitResult: BankCommitResult | null
  error: string | null
  onCommit: () => void
}): JSX.Element {
  const rows = preview.rows
  const columns = rows.length > 0 ? Object.keys(rows[0]!.row) : []

  // A structural (whole-file) rejection ingests nothing: no summary line, no
  // table, no commit button, just the reasons. Mirrors BankUploadPage's old
  // step === 'upload' structural-error branch, which never coexisted with the
  // review table for the same reason.
  if (preview.structuralErrors.length > 0) {
    return (
      <div className="space-y-4">
        {error !== null && <ErrorNote>{error}</ErrorNote>}
        <ErrorNote>
          <ul className="space-y-1">
            {preview.structuralErrors.map((se) => (
              <li key={se.code}>{se.message}</li>
            ))}
          </ul>
        </ErrorNote>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error !== null && <ErrorNote>{error}</ErrorNote>}

      <div className="space-y-3">
        <p className="text-[13px] text-muted-foreground">
          {preview.summary.total} row(s) previewed: {preview.summary.valid} valid, {preview.summary.invalid} invalid.
        </p>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Row</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Errors</TableHead>
                {columns.map((c) => (
                  <TableHead key={c}>{c}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.rowNo}>
                  <TableCell className="num">{r.rowNo}</TableCell>
                  <TableCell>
                    <StatusPill value={r.valid ? 'valid' : 'invalid'} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      {r.errors.map((code) => (
                        <StatusPill key={code} value={code} />
                      ))}
                      {/*
                        Ruling 2026-08-10: a duplicate_vpa_soundbox verdict
                        names the record it collides with, so the operator
                        can judge it here rather than opening the queue to
                        find out what "duplicate" meant. `duplicateOf` is a
                        SIBLING of `row`, so the reflective column
                        derivation above is untouched by it.
                      */}
                      {r.duplicateOf !== undefined && (
                        <span className="text-[13px] text-muted-foreground">
                          {`duplicate of ${r.duplicateOf.reference}`}
                          {r.duplicateOf.merchantDisplayName !== null && ` (${r.duplicateOf.merchantDisplayName})`}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  {columns.map((c) => (
                    <TableCell key={c}>
                      {String((r.row as unknown as Record<string, unknown>)[c] ?? '')}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {commitResult === null && (
          <p className="text-[13px] text-muted-foreground">
            {preview.summary.valid} row(s) will be committed; {preview.summary.invalid} will be held or skipped.
          </p>
        )}
        {commitResult === null && (
          <Button type="button" onClick={onCommit} disabled={committing || rows.length === 0} className="self-start">
            {committing && <Loader2 className="animate-spin" aria-hidden="true" />}
            Commit bank request file
          </Button>
        )}
        {commitResult !== null && <PerRowErrors result={commitResult} />}
      </div>
    </div>
  )
}
