import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { BankIngestPage } from './BankIngestPage.js'
import { ReturnUploadPage } from './ReturnUploadPage.js'
import { StatusUploadPage } from './StatusUploadPage.js'
import { ActivationUploadPage } from './ActivationUploadPage.js'
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
// Equal choices are now equal cards, each on its own route. Nothing is
// preselected and each upload is linkable.
//
// EVERY card here is a FILE ARRIVING FROM OUTSIDE. That is the organising idea:
// the dispatch BRD's Phase-1 exchanges are all files sent by email (bank request,
// manufacturer inventory, print vendor return, courier statuses, CWD activation
// results), so the operator's mental model is "I have a file, I go to Uploads".
// What each file SETS IN MOTION lives on the page that owns it (Batches,
// Dispatches, Activation), and those pages link back here.
//
// The bank card ENDS AT COMMIT. Generation moved to the batch that mints the
// Dispatch IDs (/batches/:id/generate); see BankIngestPage for why.

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
    description: 'New soundbox requests. Check the per-row verdict, commit; the rows pool toward the next batch.',
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
  {
    slug: 'return',
    title: 'Print vendor return',
    source: 'From the print vendor',
    description:
      'The dispatch sheet returned with Device ID and AWB filled in. Pairs devices and creates the shipments.',
    columns: ['Dispatch ID', 'Device ID', 'AWB'],
  },
  {
    slug: 'statuses',
    title: 'Courier statuses',
    source: 'From the courier',
    description:
      'Batch status updates while no webhook is integrated: picked up, in transit, out for delivery, delivered.',
    columns: ['AWB', 'Status'],
  },
  {
    slug: 'activation',
    title: 'CWD activation results',
    source: 'From CWD',
    description:
      'The activation outcomes CWD returns by email in Phase 1. Marks delivered dispatches activated.',
    columns: ['Dispatch ID'],
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
      {/* bank/* keeps matching the old wizard's deep links (/uploads/bank/upload
          etc.), all landing on the one page that replaced them. */}
      <Route path="bank/*" element={<UploadFrame><BankIngestPage /></UploadFrame>} />
      <Route path="damage" element={<UploadFrame><DamageUploadPage /></UploadFrame>} />
      <Route path="device-inventory" element={<UploadFrame><DeviceInventoryUploadPage /></UploadFrame>} />
      <Route path="return" element={<UploadFrame><ReturnUploadPage /></UploadFrame>} />
      <Route path="statuses" element={<UploadFrame><StatusUploadPage /></UploadFrame>} />
      <Route path="activation" element={<UploadFrame><ActivationUploadPage /></UploadFrame>} />
      {/* An unknown upload slug lands on the choices rather than a dead end. */}
      <Route path="*" element={<Navigate to="/uploads" replace />} />
    </Routes>
  )
}
