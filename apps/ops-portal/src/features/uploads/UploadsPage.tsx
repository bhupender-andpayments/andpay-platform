import { Navigate, Route, Routes } from 'react-router-dom'
import { BankIngestPage } from './BankIngestPage.js'
import { ReturnUploadPage } from './ReturnUploadPage.js'
import { CourierStatusUploadPage } from './CourierStatusUploadPage.js'
import { ActivationUploadPage } from './ActivationUploadPage.js'
import { SmartUploadPage } from './SmartUploadPage.js'

// The five-card catalogue that used to live at bare /uploads (replicated from
// the pdf-generation branch, 13 Aug 2026) is RETIRED as of Task 10, 2026-08-18:
// the smart dropzone is the landing now, not a card bolted onto that
// catalogue, so /uploads redirects straight to it rather than to an index of
// cards. What each kind SETS IN MOTION still lives on the page that owns it
// (Batches, Dispatches, Activation), and the smart page's own kind links (for
// an operator who already knows what they hold) replace the catalogue's job.

export function UploadsPage() {
  return (
    <Routes>
      <Route index element={<Navigate to="smart" replace />} />
      <Route path="smart" element={<SmartUploadPage />} />
      <Route path="bank" element={<BankIngestPage />} />
      <Route path="return" element={<ReturnUploadPage />} />
      <Route path="courier-status" element={<CourierStatusUploadPage />} />
      <Route path="activation" element={<ActivationUploadPage />} />
      {/* Kinds another section owns, plus the old pdf-era slug. Declared HERE
          rather than in routes.tsx because this file's own path="*" catch-all
          below already matches these paths, and a redirect in the parent
          <Routes> tree does not reliably win against it. */}
      <Route path="device-inventory" element={<Navigate to="/inventory/upload" replace />} />
      <Route path="statuses" element={<Navigate to="/uploads/courier-status" replace />} />
      {/* An unknown upload slug lands on the smart page rather than a dead
          end. This also catches the retired /uploads/damage bookmark (D-25):
          there is no damage file any more, so the honest landing is the
          smart dropzone. */}
      <Route path="*" element={<Navigate to="/uploads" replace />} />
    </Routes>
  )
}
