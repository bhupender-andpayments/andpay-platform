import ExcelJS from 'exceljs'
import { PDFDocument } from 'pdf-lib'
import { toUuid, fromUuid } from '@andpay/ids'
import type { FulfillmentDb } from './db.js'
import type { AssetStore } from './storage/asset-store.js'
import { decodeBankQrPayload } from '@andpay/bank-qr'

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
  /** The batch this line was built for, echoed onto every operator-workbook row. */
  btchId: string
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
      // The batch this line belongs to, carried onto every row of the operator
      // workbook. The print vendor receives ONE workbook per batch but works
      // several at a time, so without this the returned file cannot be told
      // apart from another batch's by looking at it.
      btchId,
      bankReferenceCode: e.bank_reference_code,
      branchCode: e.branch_code,
      artifacts: artifactsByAsgn.get(e.asgn_id) ?? [],
      labelDisplayName: e.merchant_display_name,
      // decodeBankQrPayload: the vendor may print from this column, so it is an
      // artifact boundary too, not just a report field. See @andpay/bank-qr.
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

const DISPATCH_COLUMNS = [
  { header: 'Bank', key: 'bank' },
  { header: 'Branch', key: 'branch' },
  // 'Dispatch ID' is the BRD FR-04 name for this column and what the print
  // vendor is told to key their return on. It was shipped as 'Assignment';
  // the return parser accepts BOTH names (RETURN_COLUMN_ALIASES), so old
  // sheets in flight keep parsing while new ones carry the BRD name.
  { header: 'Dispatch ID', key: 'asgnId' },
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
  // THE RETURN COLUMNS. Written EMPTY on purpose: the print vendor fills them in
  // and sends the same workbook back (BRD FR-05).
  //
  // These close a round trip that did not close. `return-sheet-adapter.ts:17`
  // states the requirement as "the vendor returns OUR dispatch sheet with Device
  // ID and AWB filled in", and its RETURN_COLUMN_ALIASES require exactly
  // `Device ID` and `AWB`, with `Assignment` already accepted as the Dispatch ID.
  // But this sheet shipped neither column, so the file we sent could never be the
  // file we accept: a vendor had to add two columns by hand, spelled exactly
  // right, with nothing telling them so.
  //
  // KEEP THESE HEADERS IN STEP WITH RETURN_COLUMN_ALIASES in
  // services/fulfillment/src/return-sheet-adapter.ts. A test asserts the two
  // agree, because a silent rename here breaks pairing for a whole batch and the
  // symptom appears at the far end, as a missing_column on a file the vendor
  // filled in correctly.
  { header: 'Device ID', key: 'deviceId' },
  { header: 'AWB', key: 'awb' },
  // Optional on the way back: an unknown courier code is recorded as an exception
  // and the row is still paired (return-sheet.ts:307).
  { header: 'Courier Partner', key: 'courierPartner' },
]

/**
 * D-5 / F9. The dispatch workbook carries TWO SHEETS, `Soundbox` and `Standy`,
 * with IDENTICAL columns. This is not a guess: it is measured from the print
 * vendor's own working file (`Sent to Printer15 May to 19 May.xlsx`), which is
 * exactly one workbook with those two sheets and one shared header row.
 *
 * F9 asked to "confirm the soundbox-only variant yields a filtered EXCEL". It
 * did not, and the framing was wrong twice over: the soundbox-only view that
 * existed was the merged PDF (`assembleTypePdf('SOUNDBOX_IMG')`), the Excel was
 * never filtered at all, and the partner does not want a filtered FILE. They
 * want one file split by PRODUCT.
 *
 * THE SPLIT IS BY PRODUCT AND DELIBERATELY OVERLAPS. Measured in that same
 * file: Standy 340 rows, Soundbox 116 rows, and **111 merchants appear in
 * BOTH**, which is precisely the set needing a soundbox AND a standee. Every
 * Standy row had `Standee Count >= 1`; every Soundbox row had `Soundbox = Y`.
 * So a merchant is on a sheet because of what must be PRINTED for them, not
 * because of a partition, and duplicating those 111 is correct, not a bug.
 *
 * NO LINE MAY VANISH. A line needing neither product would match neither rule
 * and silently disappear from the picking sheet, which means a merchant's kit
 * never gets printed. Those lines go on `Standy` and are counted, never
 * dropped; see the orphan handling below.
 */
/**
 * THE OPERATOR'S COPY (ruled by product, 2026-08-12).
 *
 * "Simply we will have as many rows as we get in the initial ingestion file.
 * Simple. And after the final generation, simply we need that same file of that
 * batch, same entries, with three extra: Dispatch ID and two empty columns."
 * Phase 1 is people re-keying spreadsheets, so the file they get back must look
 * like the file they sent, not like a new format they have to learn.
 *
 * So: the merchant's own columns, then EXACTLY THREE appended.
 *
 * What is deliberately NOT here, all of which was:
 *   - `Artifact Refs`, holding `dev-asset:artifact/<btch>/<uuid>/STANDEE_IMG:v1`
 *     storage pointers. Internal asset layout, meaningless to a vendor, and it
 *     should not ride a file that leaves the building.
 *   - `Courier Partner`. It is a fourth appended column and was never asked for.
 *     Dropping it is safe for the round trip: the return ingest treats courier as
 *     OPTIONAL (an unrecognised code is recorded as a non-blocking exception and
 *     the row still pairs), and the courier is established by the status upload.
 *
 * One honest limit. This is the merchant data as the pipeline HOLDS it, not a
 * byte-for-byte echo of the bank's sheet. The bank ships Address / Address2 /
 * Address3 / City / State / Pincode and the source profile joins them into one
 * address before anything is stored, and Email ID / QR Type / Category Code are
 * not carried on PackageLine at all. Reproducing the bank's exact header list
 * would mean widening the read, not reformatting here.
 */
const OPS_DISPATCH_COLUMNS = [
  { header: 'Bank', key: 'bank' },
  { header: 'Branch', key: 'branch' },
  { header: 'Merchant', key: 'labelDisplayName' },
  { header: 'Legal Name', key: 'merchantLegalName' },
  { header: 'Soundbox', key: 'soundbox' },
  { header: 'Standee Count', key: 'standeeCount' },
  { header: 'Sticker Count', key: 'stickerCount' },
  { header: 'QR', key: 'labelQr' },
  { header: 'Ship To', key: 'shipToAddress' },
  { header: 'Contact', key: 'contactName' },
  { header: 'Mobile', key: 'mobile' },
  // Which batch this row came from, the same wire id on every row of both
  // sheets. The vendor works several batches at once and returns the workbook
  // as-is, so this is what identifies the file without opening the portal.
  { header: 'Batch ID', key: 'btchId' },
  // THE THREE. Dispatch ID filled, the other two empty for the vendor.
  { header: 'Dispatch ID', key: 'asgnId' },
  { header: 'Device ID', key: 'deviceId' },
  { header: 'AWB', key: 'awb' },
]

/**
 * Which reader the workbook is for.
 *
 * BOTH variants are now two sheets split by product (Soundbox / Standy). 'ops'
 * differs only in its COLUMN list: the operator copy drops the internal
 * `Artifact Refs` asset pointers and `Courier Partner`, and carries `Batch ID`.
 *
 * The ops variant was briefly ONE sheet. That was the right fix for the wrong
 * problem: the complaint was that a three-merchant batch showed two rows on the
 * first sheet (the third merchant had no soundbox, so he was correctly only on
 * sheet two), which reads as a broken export. Product has since ruled the split
 * is what the print vendor works from, so it is back, and the real cure for that
 * confusion is the per-product Dispatch ID change (each line then appears on
 * exactly ONE sheet, and nothing looks missing because nothing is).
 *
 * UNTIL that lands, one Dispatch ID per merchant means a merchant wanting both
 * products appears on BOTH sheets with the SAME Dispatch ID. Say so when handing
 * the file over; it is the known gap, not a defect in the split.
 */
export type DispatchXlsxVariant = 'vendor' | 'ops'

export async function dispatchXlsx(lines: PackageLine[], variant: DispatchXlsxVariant = 'vendor'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const columns = variant === 'ops' ? OPS_DISPATCH_COLUMNS : DISPATCH_COLUMNS
  const soundboxLines = lines.filter((l) => l.soundbox)
  // Anything with something to PRINT belongs on Standy. The predicate used to
  // be `standeeCount >= 1` alone, which sent a sticker-only line into the
  // orphan bucket below and onto the same sheet by accident. Same destination,
  // but now it is the rule rather than a fallback catching it.
  const printLines = lines.filter((l) => l.standeeCount >= 1 || l.stickerCount >= 1)
  // A line on NEITHER sheet would be silently lost. Keep it visible on Standy,
  // which is the general collateral sheet, rather than letting a merchant fall
  // out of the package entirely.
  const orphans = lines.filter((l) => !l.soundbox && l.standeeCount < 1 && l.stickerCount < 1)
  addSheet(wb, 'Soundbox', soundboxLines, columns)
  addSheet(wb, 'Standy', [...printLines, ...orphans], columns)
  const arrayBuf = await wb.xlsx.writeBuffer()
  return Buffer.from(arrayBuf)
}

function addSheet(
  wb: ExcelJS.Workbook,
  name: string,
  lines: PackageLine[],
  columns: ReadonlyArray<{ header: string; key: string }>,
): void {
  const ws = wb.addWorksheet(name)
  // The column list is what selects fields: writeRows keys its addRow object by
  // column key, and a key with no matching column is ignored.
  ws.columns = [...columns]
  writeRows(ws, lines)
}

// Phase 4 (P4-D5): serialize the (already bank+branch-sorted) package lines.
// Shared by the vendor pull and the ops download so both surfaces produce the
// SAME sorted sheets. artifactRefs are joined into one cell; image BYTES are
// delivered as the per-type PDFs, not embedded here.
function writeRows(ws: ExcelJS.Worksheet, lines: PackageLine[]): void {
  for (const l of lines) {
    ws.addRow({
      bank: l.bankReferenceCode,
      branch: l.branchCode ?? '',
      asgnId: l.asgnId,
      // Only the ops column list carries this; a key with no matching column is
      // ignored, so the vendor sheet is byte-identical to before.
      btchId: l.btchId,
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
