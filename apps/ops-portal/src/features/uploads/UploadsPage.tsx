import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { DamageUploadPage } from './DamageUploadPage.js'
import { DeviceInventoryUploadPage } from './DeviceInventoryUploadPage.js'
import { CourierStatusUploadPage } from './CourierStatusUploadPage.js'
import { UPLOAD_KINDS, INDEX_STEPS } from './uploadKinds.js'
import { UploadStepper } from './UploadStepper.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// Redesign step 4 made this three equal CARDS after the tabs-era page
// preselected "Bank Requests" and shared one url; see the git history of this
// comment for that story. The 2026-08-11 ruling keeps both fixes, removes the
// remaining drill-in-and-back (uploads is now ONE continuous flow with a
// numbered step rail per kind), AND moves the bank upload out entirely: it is
// now stages 1 and 2 of the workflow workspace, so there are only two cards
// left here. This file is only the router plus step 1 (the choice); each
// upload page renders its own rail and step bodies, because the two are
// different workflows sharing a step shape, not one workflow with a type
// switch.
//
// Still binding, from the tabs-era defects: NOTHING is preselected here, and
// each upload keeps its own url so "the damage upload" stays a sendable link.
// Choosing navigates with REPLACE: moving between steps of one flow should
// not stack history entries.

function UploadsIndex() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Uploads</h1>
        <p className="text-sm text-muted-foreground">
          Choose the file you have. Each one is parsed on the server and shows a per-row outcome before anything is
          committed.
        </p>
      </div>

      <UploadStepper
        steps={INDEX_STEPS}
        current="choose"
        unlocked={['choose']}
        onStepClick={() => {}}
        guidance="Pick the file you have. The remaining steps appear once you choose."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {UPLOAD_KINDS.map((kind) => (
          <Link
            key={kind.slug}
            to={kind.slug}
            replace
            className="rounded-4xl transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:-translate-y-0.5"
          >
            <Card className="h-full">
              <CardHeader>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {kind.source}
                </p>
                <CardTitle>{kind.title}</CardTitle>
                <CardDescription>{kind.description}</CardDescription>
              </CardHeader>
              {kind.columns !== undefined && (
                <CardContent>
                  <p className="text-xs text-muted-foreground">
                    Required columns: <span className="font-medium text-foreground">{kind.columns.join(', ')}</span>
                  </p>
                </CardContent>
              )}
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}

export function UploadsPage() {
  return (
    <Routes>
      <Route index element={<UploadsIndex />} />
      {/* The bank flow moved into the workflow workspace (2026-08-11 ruling): it
          is stages 1 and 2 of one continuous lifecycle, not a standalone upload.
          Declared HERE rather than in routes.tsx because this file's own
          path="*" catch-all below already matches /uploads/bank, and a redirect
          in the parent <Routes> tree does not reliably win against it. */}
      <Route path="bank" element={<Navigate to="/workflow" replace />} />
      <Route path="damage" element={<DamageUploadPage />} />
      <Route path="device-inventory" element={<DeviceInventoryUploadPage />} />
      <Route path="courier-status" element={<CourierStatusUploadPage />} />
      {/* An unknown upload slug lands on the choices rather than a dead end. */}
      <Route path="*" element={<Navigate to="/uploads" replace />} />
    </Routes>
  )
}
