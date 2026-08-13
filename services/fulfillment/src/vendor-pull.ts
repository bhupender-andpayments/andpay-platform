import { toUuid, fromUuid } from '@andpay/ids'
import { authorize, type LeanClaim } from '@andpay/authz'
import type { FulfillmentDb } from './db.js'
import { enterVendorReadScope } from './vendor-read-context.js'
import { buildDispatchGroupXlsx, assembleGroupPdf, resolveCollateralGroup } from './package.js'
import type { AssetStore } from './storage/asset-store.js'
import { emitVendorAuthzAudit } from './vendor-audit.js'
import { loadFulfillmentConfig } from './authz-config.js'

const PULL_OPERATION = 'batch:pull-artifacts'

export class PullDeniedError extends Error {
  constructor(public readonly reason: string) {
    super(reason)
    this.name = 'PullDeniedError'
  }
}

export interface PullXlsxResult {
  xlsx: Buffer | null
  btchId: string
}

// FR-04 dispatch-package pull, a D104 PII-disclosure surface. Flow:
// 1) enter fulfillment_vendor_read + app.vndr_id (server-derived from the
//    authenticated scope.vndr, D99) and resolve the batch's print_vndr; RLS
//    returns the row IFF it is this vendor's (fail-closed).
// 2) authorize batch:pull-artifacts binding resource.vndrId to the RESOLVED
//    print_vndr (wire form); emit the ALLOW/DENY 6e durable-BEFORE the return
//    (synchronous-standalone, IDs+enums only).
// 3) resolve the DELIVERY GROUP and build the ship-view package, serialized to
//    a single .xlsx (one row per line; artifactRefs joined into one column;
//    image BYTES parked). The payload is NEVER persisted and NEVER logged
//    (S7/D104).
export async function pullDispatchPackageXlsx(
  db: FulfillmentDb,
  claim: LeanClaim,
  btchIdWire: string,
  groupKey: string,
  traceId: string,
): Promise<PullXlsxResult> {
  const btchUuid = toUuid(btchIdWire)
  const vndrUuid = toUuid(claim.scope.vndr!)

  // Step 1: resolve the batch under the vendor-read role (RLS => own-only).
  const printVndrWire = await db.$transaction(async (tx) => {
    await enterVendorReadScope(tx, vndrUuid)
    const rows = await tx.$queryRaw<{ print_vndr: string | null }[]>`
      SELECT print_vndr::text AS print_vndr FROM batch WHERE id = ${btchUuid}::uuid
    `
    const pv = rows[0]?.print_vndr
    return pv ? fromUuid('vndr', pv) : null
  })

  // Step 2: authorize + audit. A not-own/not-found batch has no resolvable
  // print_vndr, so the authorize denies (scope-denied) and we emit DENY. The
  // audit is IDs-and-enums only (S7/S10.5) and is awaited (durable) BEFORE the
  // .xlsx is returned or the PullDeniedError is thrown.
  const decision = authorize(
    claim,
    PULL_OPERATION,
    { vndrId: printVndrWire ?? '__none__' },
    loadFulfillmentConfig(),
    // D-9b: the work-queue axis DOES NOT APPLY to a pull, so it is switched off
    // here rather than left to silently deny. Every other class-6 operation is a
    // SUBMISSION, and takes the work queue from the artifact the vendor sends
    // (`sheet.workQueue`, `file.workQueue`, `ev.workQueue`), which the vendor's
    // credential must then match. A pull sends nothing, and a batch carries no
    // work-queue column, so there is no value to compare against.
    //
    // Before this, both pull call sites passed a resource with NO workQueue
    // while class 6 enforced that axis, and `credential_projection.work_queue`
    // is NOT NULL, so a class-6 claim ALWAYS carried one: `undefined !== 'wq-x'`
    // made every class-6 pull scope-denied BY CONSTRUCTION. The corpus grants
    // `batch:pull-artifacts` to the MANUFACTURER and PRINT sets, so the code was
    // contradicting the grant by making it inert; this aligns code to corpus
    // rather than changing the corpus.
    //
    // NOTHING REAL IS LOST. Vendor isolation is carried by the vndrId axis,
    // which still runs for both classes, and again at the database by the
    // RESTRICTIVE `print_vndr = app.vndr_id` RLS policy. Class 7 already skips
    // this axis on this very operation (14a Fork C), so the two classes now
    // agree instead of differing for no stated reason.
    { enforceWorkQueue: false },
  )
  await emitVendorAuthzAudit(db, {
    principalId: claim.sub,
    cls: claim.cls,
    operation: PULL_OPERATION,
    decision: decision.allowed ? 'ALLOW' : 'DENY',
    outcome: decision.allowed ? 'authorized' : 'denied',
    reasonCode: decision.allowed ? undefined : (decision.reason ?? 'denied'),
    resourceIds: [claim.scope.vndr!, btchIdWire],
    actorChannel: 'vendor-edge',
    traceId,
  })
  if (!decision.allowed) throw new PullDeniedError(decision.reason ?? 'denied')

  // Step 3: build + serialize. buildDispatchPackage reads composed_artifact,
  // on which fulfillment_vendor_read has NO grant, so it must NOT run under the
  // vendor-read role. Isolation is already guaranteed: step 1 resolved this
  // exact btchId under the RLS-scoped role (own-only, else printVndrWire is
  // null and we denied above), and the authorize confirmed batch.print_vndr ==
  // scope.vndr. buildDispatchPackage is btchId-scoped, so building it under the
  // normal connection leaks nothing.
  // E1 (2026-08-10): the pull is per DELIVERY GROUP, same key grammar as the
  // PDF pull below, resolved AFTER the authorize so an unknown key still
  // leaves the 6e trail. null maps to the caller's 404, as the PDF's does.
  const group = resolveCollateralGroup(groupKey)
  if (group === null) return { xlsx: null, btchId: btchIdWire }
  // Phase 4 (P4-D5): the ship view, now returned bank+branch-sorted, serialized
  // by the shared dispatchGroupXlsx builder (same sheet the ops download
  // produces, for the SAME delivery group).
  // D-11 exception (13 Aug 2026): the count columns are worded for THIS vendor's
  // own press, so a grid vendor is not handed a pre-imposed run and a bare copy
  // count at once. buildDispatchGroupXlsx is the ops download's builder too, so
  // the two doors cannot word the same batch's sheet differently.
  const xlsx = await buildDispatchGroupXlsx(db, btchIdWire, group, 'ship')
  return { xlsx, btchId: btchIdWire }
}

export interface PullPdfResult {
  pdf: Buffer | null
  btchId: string
}

// Phase 4 (FR-04, P4-D6): the merged collateral PDF pull, the image half of the
// dispatch-package disclosure surface. Same D104 authz as the xlsx pull --
// resolve print_vndr under the vendor-read role (RLS own-only), authorize
// batch:pull-artifacts binding the RESOLVED print_vndr, emit the ALLOW/DENY 6e
// durable-BEFORE returning -- then assemble the PDF under the NORMAL connection
// (fulfillment_vendor_read has no composed_artifact grant, and isolation is
// already guaranteed by the own-only resolve + authorize above, exactly as
// pullDispatchPackageXlsx documents).
//
// `collateralKey` is now a DELIVERY GROUP ('SOUNDBOX' or 'COLLATERAL'), and the
// three legacy artifact-type strings still resolve to the group that carries
// that product, so a URL a vendor already holds keeps working. pdf is null when
// the batch has nothing in that group, and for an unknown key, which the caller
// maps to the same 404 as before. The authz and audit flow above is untouched:
// it never depended on the key.
export async function pullTypePdf(
  db: FulfillmentDb,
  assetStore: AssetStore,
  claim: LeanClaim,
  btchIdWire: string,
  collateralKey: string,
  traceId: string,
): Promise<PullPdfResult> {
  const btchUuid = toUuid(btchIdWire)
  const vndrUuid = toUuid(claim.scope.vndr!)

  const printVndrWire = await db.$transaction(async (tx) => {
    await enterVendorReadScope(tx, vndrUuid)
    const rows = await tx.$queryRaw<{ print_vndr: string | null }[]>`
      SELECT print_vndr::text AS print_vndr FROM batch WHERE id = ${btchUuid}::uuid
    `
    const pv = rows[0]?.print_vndr
    return pv ? fromUuid('vndr', pv) : null
  })

  const decision = authorize(
    claim,
    PULL_OPERATION,
    { vndrId: printVndrWire ?? '__none__' },
    loadFulfillmentConfig(),
    // D-9b: same as the xlsx pull above. The work-queue axis does not apply
    // to a pull (nothing is submitted, and a batch carries no work queue), so it
    // is switched off rather than left to silently deny. See the full reasoning
    // at the first call site.
    { enforceWorkQueue: false },
  )
  await emitVendorAuthzAudit(db, {
    principalId: claim.sub,
    cls: claim.cls,
    operation: PULL_OPERATION,
    decision: decision.allowed ? 'ALLOW' : 'DENY',
    outcome: decision.allowed ? 'authorized' : 'denied',
    reasonCode: decision.allowed ? undefined : (decision.reason ?? 'denied'),
    resourceIds: [claim.scope.vndr!, btchIdWire],
    actorChannel: 'vendor-edge',
    traceId,
  })
  if (!decision.allowed) throw new PullDeniedError(decision.reason ?? 'denied')

  const bytes = await assembleGroupPdf(db, assetStore, btchIdWire, collateralKey)
  return { pdf: bytes === null ? null : Buffer.from(bytes), btchId: btchIdWire }
}
