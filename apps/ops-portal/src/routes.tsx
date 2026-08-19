import { Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom'
import { useAuth } from './auth/AuthContext.js'
import { LoginPage } from './auth/LoginPage.js'
import { RequireAuth } from './components/RequireAuth.js'
import { AppShell } from './ui/AppShell.js'
import { TilesPage } from './features/dashboards/TilesPage.js'
import { PlatformOverviewPage } from './features/overview/PlatformOverviewPage.js'
import { ReportPage } from './features/dashboards/ReportPage.js'
import { QueuesPage } from './features/queues/QueuesPage.js'
import { MasterDataPage } from './features/masterdata/MasterDataPage.js'
import { UploadsPage } from './features/uploads/UploadsPage.js'
import { DispatchesPage } from './features/dispatches/DispatchesPage.js'
import { DispatchDetailPage } from './features/dispatches/DispatchDetailPage.js'
import { ShipmentDetailPage } from './features/dispatches/ShipmentDetailPage.js'
import { ShipmentsPage } from './features/dispatches/ShipmentsPage.js'
import { DamageCasesPage } from './features/damage/DamageCasesPage.js'
import { InventoryPage } from './features/inventory/InventoryPage.js'
import { DeviceDetailPage } from './features/inventory/DeviceDetailPage.js'
import { DeviceInventoryUploadPage } from './features/uploads/DeviceInventoryUploadPage.js'
import { ActivationPage } from './features/activation/ActivationPage.js'
import { ActivationBatchDevicesPage } from './features/activation/ActivationBatchDevicesPage.js'
import { MerchantsPage } from './features/merchants/MerchantsPage.js'
import { MerchantDetailPage } from './features/merchants/MerchantDetailPage.js'
import { FulfillmentPage } from './features/fulfillment/FulfillmentPage.js'
import { PoolPage } from './features/fulfillment/PoolPage.js'
import { BatchGeneratePage } from './features/fulfillment/generate/BatchGeneratePage.js'

// Router-agnostic route tree (no <BrowserRouter> here) so tests can wrap it
// in a <MemoryRouter> with a chosen initialEntries, per Task 9's test plan.
// App.tsx supplies the real <BrowserRouter> for the running app.

// The login route redirects away from itself once a principal already
// exists, the mirror image of RequireAuth. Neither side is an authorization
// decision: both only steer navigation over a display-only principal.
function LoginRoute() {
  const { principal } = useAuth()
  // The post-login destination, and ONE OF THREE definitions of where an operator
  // lands. The other two are the `/` redirect and the `*` catch-all at the bottom
  // of this file. None of the three was tested, so they were free to be changed
  // one at a time and disagree in silence; all three now name Uploads and all
  // three are pinned in test/routes.test.tsx.
  //
  // UPLOADS, since 13 Aug 2026. The landing page should be where the day starts,
  // and a day starts with a file somebody emailed us. It was /workflow, a
  // workspace built around a batch that does not exist yet at the moment an
  // operator signs in.
  if (principal !== null) return <Navigate to="/uploads" replace />
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
          {/* The POOL, its own route since 18 Aug 2026 (decision D14): what is
              waiting to be batched is a different job from working the batches
              already formed, and one page could not honestly describe both. */}
          <Route path="/pool" element={<PoolPage />} />
          <Route path="/batches" element={<FulfillmentPage />} />
          {/* ONE batch page (13 Aug 2026). The collateral generator IS the batch
              page: an operator opening a batch is there to see the cards, print
              them, and hand the vendor its workbook. The former detail page's
              summary is folded into this one's header, so there is nothing left
              behind a second route. */}
          <Route path="/batches/:btchId" element={<BatchGeneratePage />} />
          <Route path="/activation" element={<ActivationPage />} />
          {/* Batch-first drill-down (decision D8): a batch's devices, one click
              from Activation, and one more click into the existing device page. */}
          <Route path="/activation/batch/:btchId" element={<ActivationBatchDevicesPage />} />
          {/* Redesign step 7: the entity the object-first nav was missing. */}
          <Route path="/merchants" element={<MerchantsPage />} />
          <Route path="/merchants/:mrchId" element={<MerchantDetailPage />} />
          {/* Step 4: uploads are linkable routes behind an index of cards, so
              `/uploads/*` is delegated to the feature. TWO of them now, not
              three: the 2026-08-11 ruling moved the bank upload into the
              workspace as its first two stages, and /uploads/bank redirects
              there. */}
          <Route path="/uploads/*" element={<UploadsPage />} />
          {/* Section 4: Operations dissolved. Its two remaining verbs, status
              correction and terminal override, are now actions on the dispatch
              they act on, and recompose moved onto the batch. */}
          {/* The flow, explained. Static: no reads, so it cannot go stale in the
              way a dashboard can, and it cannot go blank when a service is down.
              Beside Command Center under Overview, because it is the other
              question a person arrives with. */}
          <Route path="/overview" element={<PlatformOverviewPage />} />
          <Route path="/dispatches" element={<DispatchesPage />} />
          {/* D-16 (T4.5): one Dispatch ID's two branches. Nested under
              /dispatches because that list is where an operator arrives from,
              the same relationship /batches/:btchId has to /batches. */}
          <Route path="/dispatches/:asgnId" element={<DispatchDetailPage />} />
          {/* SHIPMENTS IS ITS OWN SECTION (19 Aug 2026), not a ?view= tab on the
              dispatch list and not a /dispatches/shipment/:id detail hanging off
              it. A parcel's page is somewhere an operator ARRIVES, holding an AWB
              off a courier's website, so leaving it has to lead back to the
              shipment list; under the tab there was no such route to lead back
              to, and the back link dropped them on the other grain's table.
              ShipmentsPage.tsx carries the full account.

              The old paths still resolve, because links to them are in circulation
              (pasted in chats, bookmarked during testing) and a dead URL is a worse
              answer than a redirect. */}
          <Route path="/shipments" element={<ShipmentsPage />} />
          <Route path="/shipments/:shptId" element={<ShipmentDetailPage />} />
          <Route path="/dispatches/shipment/:shptId" element={<LegacyShipmentRedirect />} />
          {/* The Inventory section the redesign deferred under option B for
              want of a read. GET /ops/devices exists now, so the condition
              that kept it out is gone. Owned end-to-end from here per the
              2026-08-12 ruling: ingestion (/inventory/upload) lives INSIDE
              the section, not under the central Uploads index, and each
              device has its own detail page. /inventory/upload is registered
              before /inventory/device/:unitId only for readability; the
              paths cannot collide. */}
          <Route path="/inventory" element={<InventoryPage />} />
          {/* D-24 (T6.6): the damage cases. The read has existed at the edge
              since FR08-2 with no portal surface at all, which is most of why
              the statuses were stale: nobody could see them. */}
          <Route path="/damage-cases" element={<DamageCasesPage />} />
          <Route path="/inventory/upload" element={<DeviceInventoryUploadPage />} />
          <Route path="/inventory/device/:unitId" element={<DeviceDetailPage />} />
          {/* The queue tab is IN THE URL (2026-08-12). It was `useState`, so
              every link into this page landed on Quarantine no matter which
              queue the link was about, and a bookmark or a "look at this screen"
              link could not name a queue at all. A bare /queues redirects to the
              first tab. */}
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

          {/* WHERE AN OPERATOR LANDS, two of the three definitions of it (the
              third is LoginRoute above). The workspace, not Command Center: the
              tiles say how much is happening, and the workspace is the work.
              /dashboards above still redirects to /command-center, whose tiles
              stay exactly where they are (FR-09 keeps them). */}
          <Route path="/" element={<Navigate to="/uploads" replace />} />
          <Route path="*" element={<Navigate to="/uploads" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}

/**
 * /dispatches/shipment/:shptId -> /shipments/:shptId.
 *
 * The parcel page moved on 19 Aug 2026 when Shipments became its own section.
 * A plain <Navigate> cannot express this one because the target carries the id,
 * so the param has to be read first. `replace` so Back does not bounce between
 * the old path and the new one.
 */
function LegacyShipmentRedirect() {
  const { shptId } = useParams<{ shptId: string }>()
  return <Navigate to={shptId === undefined ? '/shipments' : `/shipments/${shptId}`} replace />
}
