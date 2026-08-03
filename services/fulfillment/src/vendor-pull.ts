import ExcelJS from 'exceljs'
import { toUuid, fromUuid } from '@andpay/ids'
import { authorize, type LeanClaim } from '@andpay/authz'
import type { FulfillmentDb } from './db.js'
import { enterVendorReadScope } from './vendor-read-context.js'
import { buildDispatchPackage } from './package.js'
import { emitVendorAuthzAudit } from './vendor-audit.js'
import { loadFulfillmentConfig } from './authz-config.js'

const PULL_OPERATION = 'batch:pull-artifacts'

export class PullDeniedError extends Error {
  constructor(public readonly reason: string) {
    super(reason)
    this.name = 'PullDeniedError'
  }
}

export interface PullResult {
  xlsx: Buffer
  btchId: string
}

// FR-04 dispatch-package pull, a D104 PII-disclosure surface. Flow:
// 1) enter fulfillment_vendor_read + app.vndr_id (server-derived from the
//    authenticated scope.vndr, D99) and resolve the batch's print_vndr; RLS
//    returns the row IFF it is this vendor's (fail-closed).
// 2) authorize batch:pull-artifacts binding resource.vndrId to the RESOLVED
//    print_vndr (wire form); emit the ALLOW/DENY 6e durable-BEFORE the return
//    (synchronous-standalone, IDs+enums only).
// 3) build the ship-view package and serialize to a single .xlsx (one row per
//    line; artifactRefs joined into one column; image BYTES parked). The
//    payload is NEVER persisted and NEVER logged (S7/D104).
export async function pullDispatchPackageXlsx(
  db: FulfillmentDb,
  claim: LeanClaim,
  btchIdWire: string,
  traceId: string,
): Promise<PullResult> {
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
  const decision = authorize(claim, PULL_OPERATION, { vndrId: printVndrWire ?? '__none__' }, loadFulfillmentConfig())
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
  const lines = await buildDispatchPackage(db, btchIdWire, 'ship')

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('dispatch')
  ws.columns = [
    { header: 'Assignment', key: 'asgnId' },
    { header: 'Merchant', key: 'labelDisplayName' },
    { header: 'QR', key: 'labelQr' },
    { header: 'Ship To', key: 'shipToAddress' },
    { header: 'Contact', key: 'contactName' },
    { header: 'Mobile', key: 'mobile' },
    { header: 'Artifact Refs', key: 'artifactRefs' },
  ]
  for (const l of lines) {
    ws.addRow({ ...l, artifactRefs: l.artifactRefs.join(' ') })
  }
  const arrayBuf = await wb.xlsx.writeBuffer()
  return { xlsx: Buffer.from(arrayBuf), btchId: btchIdWire }
}
