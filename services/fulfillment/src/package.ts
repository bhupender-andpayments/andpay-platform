import ExcelJS from 'exceljs'
import { PDFDocument } from 'pdf-lib'
import { toUuid, fromUuid } from '@andpay/ids'
import type { FulfillmentDb } from './db.js'
import type { AssetStore } from './storage/asset-store.js'
import { decodeBankQrPayload } from './qr-payload.js'

// Which adapter function the package projection is being built for. The
// entitlement below is scoped to THIS parameter, never a global field: a
// future print-only adapter passes 'print' and gets no shipping PII (D104
// default-exclude).
export type AdapterFunction = 'print' | 'ship'

export interface ArtifactRef {
  artifactType: string
  assetReference: string
}

export interface PackageLine {
  asgnId: string
  // Phase 4 (P4-D5): the sort dimensions, so callers can present/assemble the
  // package in bank + branch order and split by product type.
  bankReferenceCode: string
  branchCode: string | null
  artifacts: ArtifactRef[]
  labelDisplayName: string
  labelQr: string
  // F6: what the print vendor must actually PRODUCE. The sheet previously
  // carried who and where but never how many of what, so the vendor was never
  // told what to print. These live on the PRINT projection, not the ship-only
  // block, because they are the print instruction itself.
  //
  // merchantLegalName is included on the same footing: the collateral renderer
  // already draws it onto the artifacts the vendor receives
  // (collateral/renderer.ts includeLegal), so putting it on the sheet discloses
  // nothing the vendor does not already hold.
  soundbox: boolean
  standeeCount: number
  stickerCount: number
  merchantLegalName: string
  // present ONLY when fn === 'ship' (the entitled shipping-recipient block).
  shipToAddress?: string
  contactName?: string | null
  mobile?: string | null
}

/**
 * The per-adapter dispatch PACKAGE (spec 08 Task 7, check 2, D104): a
 * per-adapter-FUNCTION projection generated at hand-off and NOT persisted -
 * there is no stored dispatch-package table. Reads pending_pool_entry (the
 * event-carried snapshot, including the recipient fields) and
 * composed_artifact (the retained QR label artifacts) for the batch, both
 * already in the fulfillment schema: a read-only projection, never a
 * TMS/Identity read (C4). It INSERTs/UPDATEs nothing, so it needs no
 * setProgramContext; reads are open under RLS (USING(true)).
 *
 * Phase 4 (P4-D5): lines are returned SORTED by (bank_reference_code,
 * branch_code, asgnId) so the print vendor package groups by bank then branch
 * deterministically; each line carries its artifacts as {artifactType,
 * assetReference} pairs so callers can split per product type.
 *
 * Entitlement is function-scoped, not a global field: the PRINT view carries
 * the QR label collateral only (no shipping recipient PII - no shipToAddress,
 * no contactName, no mobile key at all, not merely a falsy value). The SHIP
 * view is the print view PLUS the shipping recipient block, sourced from the
 * pending_pool_entry snapshot columns.
 */
export async function buildDispatchPackage(
  db: FulfillmentDb,
  btchId: string,
  fn: AdapterFunction,
): Promise<PackageLine[]> {
  const btchUuid = toUuid(btchId)

  const entries = await db.$queryRaw<
    {
      asgn_id: string
      merchant_display_name: string
      qr_value: string
      bank_reference_code: string
      branch_code: string | null
      ship_to_address: string
      ship_to_contact_name: string | null
      ship_to_mobile: string | null
      soundbox: boolean
      standee_count: number
      sticker_count: number
      merchant_legal_name: string
    }[]
  >`
    SELECT asgn_id::text AS asgn_id, merchant_display_name, merchant_legal_name, qr_value,
           bank_reference_code, branch_code, soundbox, standee_count, sticker_count,
           ship_to_address, ship_to_contact_name, ship_to_mobile
    FROM pending_pool_entry WHERE batch = ${btchUuid}::uuid
  `

  const artifacts = await db.$queryRaw<{ asgn_id: string; artifact_type: string; asset_reference: string }[]>`
    SELECT asgn_id::text AS asgn_id, artifact_type, asset_reference
    FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid
    ORDER BY artifact_type
  `

  const artifactsByAsgn = new Map<string, ArtifactRef[]>()
  for (const a of artifacts) {
    const list = artifactsByAsgn.get(a.asgn_id) ?? []
    list.push({ artifactType: a.artifact_type, assetReference: a.asset_reference })
    artifactsByAsgn.set(a.asgn_id, list)
  }

  const lines = entries.map((e): PackageLine => {
    const print: PackageLine = {
      // e.asgn_id is already the native uuid (selected `::text` off a uuid
      // column), so it converts back to wire form via fromUuid, matching the
      // dispatch.ts precedent for asgnIds on the dispatch fact.
      asgnId: fromUuid('asgn', e.asgn_id),
      bankReferenceCode: e.bank_reference_code,
      branchCode: e.branch_code,
      artifacts: artifactsByAsgn.get(e.asgn_id) ?? [],
      labelDisplayName: e.merchant_display_name,
      // decodeBankQrPayload: the vendor may print from this column, so it is an
      // artifact boundary too, not just a report field. See qr-payload.ts.
      labelQr: decodeBankQrPayload(e.qr_value),
      soundbox: e.soundbox,
      standeeCount: e.standee_count,
      stickerCount: e.sticker_count,
      merchantLegalName: e.merchant_legal_name,
    }
    if (fn === 'print') return print
    return {
      ...print,
      shipToAddress: e.ship_to_address,
      contactName: e.ship_to_contact_name,
      mobile: e.ship_to_mobile,
    }
  })

  // Deterministic bank -> branch -> assignment ordering (P4-D5).
  lines.sort((a, b) => {
    if (a.bankReferenceCode !== b.bankReferenceCode) return a.bankReferenceCode < b.bankReferenceCode ? -1 : 1
    const ab = a.branchCode ?? ''
    const bb = b.branchCode ?? ''
    if (ab !== bb) return ab < bb ? -1 : 1
    return a.asgnId < b.asgnId ? -1 : a.asgnId > b.asgnId ? 1 : 0
  })
  return lines
}

// Phase 4 (P4-D5): serialize the (already bank+branch-sorted) package lines to a
// single dispatch .xlsx. Shared by the vendor pull and the ops download so both
// surfaces produce the SAME sorted sheet. artifactRefs are joined into one cell;
// image BYTES are delivered as the per-type PDFs, not embedded here.
export async function dispatchXlsx(lines: PackageLine[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('dispatch')
  ws.columns = [
    { header: 'Bank', key: 'bank' },
    { header: 'Branch', key: 'branch' },
    { header: 'Assignment', key: 'asgnId' },
    { header: 'Merchant', key: 'labelDisplayName' },
    { header: 'Legal Name', key: 'merchantLegalName' },
    { header: 'Soundbox', key: 'soundbox' },
    { header: 'Standee Count', key: 'standeeCount' },
    { header: 'Sticker Count', key: 'stickerCount' },
    { header: 'QR', key: 'labelQr' },
    { header: 'Ship To', key: 'shipToAddress' },
    { header: 'Contact', key: 'contactName' },
    { header: 'Mobile', key: 'mobile' },
    { header: 'Artifact Refs', key: 'artifactRefs' },
  ]
  for (const l of lines) {
    ws.addRow({
      bank: l.bankReferenceCode,
      branch: l.branchCode ?? '',
      asgnId: l.asgnId,
      labelDisplayName: l.labelDisplayName,
      merchantLegalName: l.merchantLegalName,
      // Y/N rather than TRUE/FALSE: this is read off a printed picking sheet by
      // a human, and it is how the BRD states the column.
      soundbox: l.soundbox ? 'Y' : 'N',
      standeeCount: l.standeeCount,
      stickerCount: l.stickerCount,
      labelQr: l.labelQr,
      shipToAddress: l.shipToAddress ?? '',
      contactName: l.contactName ?? '',
      mobile: l.mobile ?? '',
      artifactRefs: l.artifacts.map((a) => a.assetReference).join(' '),
    })
  }
  const arrayBuf = await wb.xlsx.writeBuffer()
  return Buffer.from(arrayBuf)
}

// A stored collateral asset a composed_artifact row references could not be
// resolved or read. This is a genuine storage FAULT (P4-2 guarantees every
// composed_artifact carries a real, readable stored reference), deliberately
// distinct from "the batch has no artifact of this type" (a legitimate empty).
// Carries only ids/enums, never PII or the bytes (S7).
export class AssetResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssetResolutionError'
  }
}

// Phase 4 (P4-D5): assemble ONE merged PDF for a single product type across the
// whole batch, in bank + branch order, by merging the stored per-collateral PDFs
// (the single source of truth is the bytes generated at composition, Task 2).
// artifactType 'SOUNDBOX_IMG' yields the FR-04 step-10 soundbox-only view.
// Returns null ONLY when the batch has no composed_artifact of that type. If a
// referenced asset exists as a row but does not resolve or is not a readable
// PDF, that is a FAULT and throws AssetResolutionError -- it must NEVER be
// collapsed into an empty/404, or a merchant's label would silently vanish from
// the dispatch package (Task-3/4 review, Important). Reads no PII ('print' view).
export async function assembleTypePdf(
  db: FulfillmentDb,
  assetStore: AssetStore,
  btchId: string,
  artifactType: string,
): Promise<Uint8Array | null> {
  const lines = await buildDispatchPackage(db, btchId, 'print')
  const merged = await PDFDocument.create()
  // Fixed metadata so the merged output is deterministic for a fixed input set.
  merged.setCreationDate(new Date(0))
  merged.setModificationDate(new Date(0))
  merged.setProducer('andpay-collateral')
  merged.setCreator('andpay-collateral')

  let matched = 0
  for (const line of lines) {
    for (const art of line.artifacts) {
      if (art.artifactType !== artifactType) continue
      matched++
      const rec = await assetStore.getByReference(art.assetReference)
      if (rec === null) {
        throw new AssetResolutionError(`stored collateral not found for a ${artifactType} artifact in batch ${btchId}`)
      }
      let src: PDFDocument
      try {
        src = await PDFDocument.load(rec.bytes)
      } catch {
        throw new AssetResolutionError(`stored collateral is not a readable PDF for a ${artifactType} artifact in batch ${btchId}`)
      }
      const pages = await merged.copyPages(src, src.getPageIndices())
      for (const pg of pages) merged.addPage(pg)
    }
  }
  if (matched === 0) return null
  return await merged.save()
}
