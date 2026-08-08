import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { BankUploadPage } from './BankUploadPage.js'
import { DamageUploadPage } from './DamageUploadPage.js'
import { DeviceInventoryUploadPage, DEVICE_INVENTORY_COLUMNS } from './DeviceInventoryUploadPage.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// Redesign step 4. This was three TABS with "Bank Requests" selected by default.
//
// Two problems, and the default is the worse one. An operator arriving to upload
// a device inventory file landed on a bank request form, with nothing saying the
// other two existed until they noticed the tab strip. And every upload shared
// one URL, so there was no way to send someone to "the damage upload".
//
// Three equal choices are now three equal cards, each on its own route. Nothing
// is preselected and each upload is linkable.
//
// The three upload components themselves are UNCHANGED. This is routing and
// presentation: the parsing, the preview/commit flow and the per-row error
// tables are all untouched.

interface UploadKind {
  slug: string
  title: string
  /** Who hands us this file. The operator knows the source, not our jargon. */
  source: string
  description: string
  /**
   * Stated ONLY where the portal has a verified list. Device inventory shares a
   * real constant with its parser. The bank and damage layouts are resolved by
   * source profile at ingest (D8), and the real GSCB file's headers differ from
   * the canonical names, so listing columns for those here would be inventing a
   * contract the portal cannot check.
   */
  columns?: readonly string[]
}

const UPLOAD_KINDS: readonly UploadKind[] = [
  {
    slug: 'bank',
    title: 'Bank requests',
    source: 'From the bank',
    description: 'New soundbox requests. Preview the per-row outcome, then commit.',
  },
  {
    slug: 'damage',
    title: 'Damage reports',
    source: 'From the bank, after delivery',
    description: 'Damaged devices to be replaced. Every row is matched to an existing dispatch.',
  },
  {
    slug: 'device-inventory',
    title: 'Device inventory',
    source: 'From the manufacturer',
    description: 'Devices received into stock, before anything can be printed or shipped.',
    columns: DEVICE_INVENTORY_COLUMNS,
  },
]

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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {UPLOAD_KINDS.map((kind) => (
          <Link
            key={kind.slug}
            to={kind.slug}
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

function UploadFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <Link to="/uploads" className="w-fit text-sm text-muted-foreground hover:text-foreground">
        Back to all uploads
      </Link>
      {children}
    </div>
  )
}

export function UploadsPage() {
  return (
    <Routes>
      <Route index element={<UploadsIndex />} />
      <Route path="bank" element={<UploadFrame><BankUploadPage /></UploadFrame>} />
      <Route path="damage" element={<UploadFrame><DamageUploadPage /></UploadFrame>} />
      <Route path="device-inventory" element={<UploadFrame><DeviceInventoryUploadPage /></UploadFrame>} />
      {/* An unknown upload slug lands on the choices rather than a dead end. */}
      <Route path="*" element={<Navigate to="/uploads" replace />} />
    </Routes>
  )
}
