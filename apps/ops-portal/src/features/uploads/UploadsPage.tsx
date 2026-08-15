import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { BankIngestPage } from './BankIngestPage.js'
import { ReturnUploadPage } from './ReturnUploadPage.js'
import { DamageUploadPage } from './DamageUploadPage.js'
import { CourierStatusUploadPage } from './CourierStatusUploadPage.js'
import { ActivationUploadPage } from './ActivationUploadPage.js'
import {
  ACTIVATION_COLUMNS,
  COURIER_STATUS_COLUMNS,
  DEVICE_INVENTORY_REQUIRED_COLUMNS,
  RETURN_COLUMNS,
} from './uploadKinds.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// The six-card index, replicated from the pdf-generation branch on the user's
// ruling (13 Aug 2026): do not invent, replicate. Six equal cards, each a FILE
// ARRIVING FROM OUTSIDE - that is the organising idea: the dispatch BRD's
// Phase-1 exchanges are all files sent by email (bank request, manufacturer
// inventory, print vendor return, courier statuses, CWD activation results),
// so the operator's mental model is "I have a file, I go to Uploads". What each
// file SETS IN MOTION lives on the page that owns it (Batches, Dispatches,
// Activation), and those pages link back here.
//
// Two departures from the replicated original, both because this branch's
// backend is newer, neither visible in the design:
//   * the device-inventory card navigates to /inventory/upload, the page the
//     Inventory section owns here (DEMO.md step 5);
//   * the columns lines state THIS branch's real parser contracts (help text
//     follows code), so the courier card says Status Date and the activation
//     card says Device ID.
//
// Still binding, from the tabs-era defects: NOTHING is preselected here, and
// each upload keeps its own url so "the damage upload" stays a sendable link.

interface UploadCard {
  slug: string
  title: string
  /** Who hands us this file. The operator knows the source, not our jargon. */
  source: string
  description: string
  columns?: readonly string[]
  /** Where the card navigates when another section owns the page. */
  route?: string
}

const UPLOAD_CARDS: readonly UploadCard[] = [
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
    // The card's line reads "Required columns", so it must carry the REQUIRED
    // set (Device ID alone, the Workflow A frozen rule), not the sheet shape.
    // Passing DEVICE_INVENTORY_COLUMNS here told an operator all three were
    // required while the upload page itself said the opposite, which is the
    // exact two-claims conflation the 13 Aug split of these constants fixed
    // (found again on this card, 16 Aug UAT walkthrough, finding A5).
    columns: DEVICE_INVENTORY_REQUIRED_COLUMNS,
    route: '/inventory/upload',
  },
  {
    slug: 'return',
    title: 'Print vendor return',
    source: 'From the print vendor',
    description:
      'The dispatch sheet returned with Device ID and AWB filled in. Pairs devices and creates the shipments.',
    columns: RETURN_COLUMNS,
  },
  {
    slug: 'courier-status',
    title: 'Courier statuses',
    source: 'From the courier',
    description:
      'Batch status updates while no webhook is integrated: picked up, in transit, out for delivery, delivered.',
    columns: COURIER_STATUS_COLUMNS,
  },
  {
    slug: 'activation',
    title: 'CWD activation results',
    source: 'From CWD',
    description: 'The activation outcomes CWD returns by email. Marks delivered dispatches activated.',
    columns: ACTIVATION_COLUMNS,
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
        {UPLOAD_CARDS.map((kind) => (
          <Link
            key={kind.slug}
            to={kind.route ?? kind.slug}
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
      <Route path="bank" element={<BankIngestPage />} />
      <Route path="return" element={<ReturnUploadPage />} />
      <Route path="damage" element={<DamageUploadPage />} />
      <Route path="courier-status" element={<CourierStatusUploadPage />} />
      <Route path="activation" element={<ActivationUploadPage />} />
      {/* Kinds another section owns, plus the old pdf-era slug. Declared HERE
          rather than in routes.tsx because this file's own path="*" catch-all
          below already matches these paths, and a redirect in the parent
          <Routes> tree does not reliably win against it. */}
      <Route path="device-inventory" element={<Navigate to="/inventory/upload" replace />} />
      <Route path="statuses" element={<Navigate to="/uploads/courier-status" replace />} />
      {/* An unknown upload slug lands on the choices rather than a dead end. */}
      <Route path="*" element={<Navigate to="/uploads" replace />} />
    </Routes>
  )
}
