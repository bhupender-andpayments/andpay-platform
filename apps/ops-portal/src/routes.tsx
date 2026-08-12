import { Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom'
import { useAuth } from './auth/AuthContext.js'
import { LoginPage } from './auth/LoginPage.js'
import { RequireAuth } from './components/RequireAuth.js'
import { AppShell } from './ui/AppShell.js'
import { TilesPage } from './features/dashboards/TilesPage.js'
import { ReportPage } from './features/dashboards/ReportPage.js'
import { QueuesPage } from './features/queues/QueuesPage.js'
import { MasterDataPage } from './features/masterdata/MasterDataPage.js'
import { UploadsPage } from './features/uploads/UploadsPage.js'
import { DispatchesPage } from './features/dispatches/DispatchesPage.js'
import { InventoryPage } from './features/inventory/InventoryPage.js'
import { ActivationPage } from './features/activation/ActivationPage.js'
import { MerchantsPage } from './features/merchants/MerchantsPage.js'
import { FulfillmentPage } from './features/fulfillment/FulfillmentPage.js'
import { BatchGeneratePage } from './features/fulfillment/generate/BatchGeneratePage.js'

// Router-agnostic route tree (no <BrowserRouter> here) so tests can wrap it
// in a <MemoryRouter> with a chosen initialEntries, per Task 9's test plan.
// App.tsx supplies the real <BrowserRouter> for the running app.

// The login route redirects away from itself once a principal already
// exists, the mirror image of RequireAuth. Neither side is an authorization
// decision: both only steer navigation over a display-only principal.
function LoginRoute() {
  const { principal } = useAuth()
  if (principal !== null) return <Navigate to="/command-center" replace />
  return <LoginPage />
}

// The authenticated shell: the branded AppShell (Phase 7 task 3, src/ui/
// AppShell.tsx) frame around whatever feature route matched. AppShell owns
// its own sidebar nav + principal/logout footer internally (Task 1), so this
// no longer composes the standalone Nav component; Nav.tsx remains a
// restyled, standalone component (see its own file) for anything that still
// mounts it directly.
function Shell() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}

// /batches/:btchId/generate is now the batch page itself. Kept as a redirect
// rather than deleted, because that URL is in browser history and in links
// already handed out, and a 404 on a working link is worse than a hop.
function RedirectToBatch() {
  const { btchId } = useParams<{ btchId: string }>()
  return <Navigate to={`/batches/${btchId ?? ''}`} replace />
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route element={<RequireAuth />}>
        <Route element={<Shell />}>
          {/* Redesign step 1: object-first routes. The batch LIST moved from
              /fulfillment to /batches so the detail route is finally a child of
              its own list rather than an unrelated sibling. That is what fixed
              the breadcrumb reading "Ops Console" on a batch detail page. */}
          <Route path="/command-center" element={<TilesPage />} />
          <Route path="/batches" element={<FulfillmentPage />} />
          {/* ONE BATCH PAGE (2026-08-12). There were two, and they were the same
              page twice: a "detail" page whose whole purpose was a Summary tile
              plus per-type PDF download buttons, and a "generate" page that
              previews the cards, renders the print run and hands over the Excel.
              An operator opening a batch landed on the weaker of the two and had
              to press Generate to reach the one that does the work, so the batch
              id was clickable to a dead end. The detail page is deleted; the
              batch's own URL now renders generation, with the Summary folded in
              so nothing it reported was lost. */}
          <Route path="/batches/:btchId" element={<BatchGeneratePage />} />
          {/* The old generate URL keeps working: it is in browser history and in
              links already handed out. `replace` so Back does not bounce. */}
          <Route path="/batches/:btchId/generate" element={<RedirectToBatch />} />
          <Route path="/activation" element={<ActivationPage />} />
          {/* Redesign step 7: the entity the object-first nav was missing. */}
          <Route path="/merchants" element={<MerchantsPage />} />
          {/* Step 4: uploads are three linkable routes behind an index of
              cards, so `/uploads/*` is delegated to the feature. */}
          <Route path="/uploads/*" element={<UploadsPage />} />
          {/* Section 4: Operations dissolved. Its two remaining verbs, status
              correction and terminal override, are now actions on the dispatch
              they act on, and recompose moved onto the batch. */}
          <Route path="/dispatches" element={<DispatchesPage />} />
          {/* The Inventory section the redesign deferred under option B for
              want of a read. GET /ops/devices exists now, so the condition
              that kept it out is gone. */}
          <Route path="/inventory" element={<InventoryPage />} />
          {/* Each queue tab is its own URL, so a link can send an operator to
              the queue it is actually about. Bare /queues still resolves: the
              page redirects it to the first tab. */}
          <Route path="/queues" element={<QueuesPage />} />
          <Route path="/queues/:tab" element={<QueuesPage />} />
          <Route path="/reports" element={<ReportPage />} />
          <Route path="/masterdata" element={<MasterDataPage />} />

          {/* The renamed routes keep working. A bookmark, a link in someone's
              notes, or a deep link in an old runbook must not 404 or silently
              land on the dashboard. `replace` so Back does not bounce. */}
          <Route path="/dashboards" element={<Navigate to="/command-center" replace />} />
          <Route path="/fulfillment" element={<Navigate to="/batches" replace />} />
          <Route path="/operations" element={<Navigate to="/dispatches" replace />} />

          <Route path="/" element={<Navigate to="/command-center" replace />} />
          <Route path="*" element={<Navigate to="/command-center" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}
