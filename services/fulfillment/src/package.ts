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

  // superseded_by IS NULL: a class-3 recompose (ops.ts recomposeArtifact) INSERTs
  // a REPLACEMENT composed_artifact row and stamps superseded_by/superseded_at on
  // the old one, so after one recompose an assignment has TWO rows of the same
  // type. Unfiltered, the merged delivery PDF printed that merchant's page twice
  // and the sheet's artifact-ref cell listed a reference that has been retired.
  // The current row is the only one the vendor should ever produce.
  //
  // ops-read.ts deliberately does NOT filter here: that read projects
  // supersededAt so an operator can SEE the history. This is the delivery path,
  // where history is a duplicate page.
  const artifacts = await db.$queryRaw<{ asgn_id: string; artifact_type: string; asset_reference: string }[]>`
    SELECT asgn_id::text AS asgn_id, artifact_type, asset_reference
    FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid AND superseded_by IS NULL
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
  // Ruled 2026-08-10 (spec section 2): the column the BRD, the walkthrough,
  // the printed artwork, and the vendor portal's return parser all call
  // 'Dispatch ID'. The Assignment name shipped in downloaded workbooks, so
  // return-sheet-adapter.ts keeps accepting BOTH; the synonym list there is
  // now the compatibility path, not a papering-over.
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
]

// E1 membership (spec 2.1). SOUNDBOX is the soundbox flag. COLLATERAL is
// standee OR sticker, mirroring GROUP_ARTIFACT_TYPES.COLLATERAL exactly, so
// every page in that PDF has a quantity row in this Excel. This closes the
// reachable defect where a soundbox-true, standee-0, sticker-1 line got a
// COLLATERAL page but matched no collateral sheet rule.
//
// The orphan rule survives and must: a line needing NEITHER product lands on
// COLLATERAL (the general collateral file) rather than vanishing, because a
// vanished line is a merchant whose kit never gets printed. ONE filter pass,
// not an append, so an orphan keeps its bank-sorted position (I4/E2).
//
// Measured against the print vendor's own working file (`Sent to Printer15
// May to 19 May.xlsx`, the source of the D-5/F9 finding this replaces): that
// file was one workbook with two sheets, Standy 340 rows and Soundbox 116,
// with 111 merchants on BOTH, exactly those needing a soundbox AND a standee.
// The split here is now two FILES rather than two sheets in one workbook, but
// the membership arithmetic is unchanged: a merchant is on a sheet because of
// what must be PRINTED for them, and the both-groups overlap is correct, not
// a bug.
export function excelLinesFor(lines: PackageLine[], group: CollateralGroup): PackageLine[] {
  if (group === 'SOUNDBOX') return lines.filter((l) => l.soundbox)
  return lines.filter((l) => l.standeeCount >= 1 || l.stickerCount >= 1 || !l.soundbox)
}

const GROUP_SHEET_NAMES: Record<CollateralGroup, string> = {
  SOUNDBOX: 'Soundbox',
  COLLATERAL: 'Collateral',
}

// E1 (spec section 2): TWO Excels per batch, one per delivery group, each a
// single sheet with the IDENTICAL column set, which is how the print vendor's
// own working file is built. The spec describes these as soundboxXlsx and
// collateralXlsx; it is one group-keyed builder because the HTTP routes are
// group-keyed, and one builder cannot drift into two column sets.
export async function dispatchGroupXlsx(lines: PackageLine[], group: CollateralGroup): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(GROUP_SHEET_NAMES[group])
  ws.columns = DISPATCH_COLUMNS
  writeRows(ws, excelLinesFor(lines, group))
  const arrayBuf = await wb.xlsx.writeBuffer()
  return Buffer.from(arrayBuf)
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

/**
 * THE DELIVERY GROUPING. A batch is handed to the print vendor as TWO merged
 * PDFs, not three per-type ones:
 *
 *   SOUNDBOX   -> one page per merchant that asked for a soundbox.
 *   COLLATERAL -> one page per merchant that asked for a sticker OR a standee,
 *                 and exactly ONE page for a merchant that asked for BOTH.
 *
 * The both case is the whole reason this is a grouping and not a concatenation.
 * Sticker and standee carry the SAME branded artwork (BRD Annexure A), so a
 * second page would be the same QR for the same VPA printed twice, which the
 * ruling forbids. Hence AT MOST ONE artifact per line per group, taken in the
 * ORDER below.
 *
 * STANDEE_IMG comes before STICKER_IMG for the same reason excelLinesFor puts
 * orphan lines on COLLATERAL: the standee is the general collateral sheet.
 *
 * STORAGE IS UNCHANGED, DELIBERATELY. composed_artifact.artifact_type keeps its
 * three values. Regrouping at the merge layer instead of at rest means no data
 * migration, `recomposeArtifact`/`resolvePriorArtifact` keep working on
 * historical rows (they key on asgn plus artifact TYPE, which is a stored row,
 * never a delivery group), the `artifact/${btchId}/${asgn_id}/${artifactType}`
 * asset key and the stored reference format stay byte-identical, and legacy
 * vendor URLs naming an artifact type still resolve.
 */
export type CollateralGroup = 'SOUNDBOX' | 'COLLATERAL'

const GROUP_ARTIFACT_TYPES: Record<CollateralGroup, readonly string[]> = {
  SOUNDBOX: ['SOUNDBOX_IMG'],
  COLLATERAL: ['STANDEE_IMG', 'STICKER_IMG'],
}

// Map a path parameter to a delivery group. Accepts the two group keys AND the
// three legacy artifact-type strings, so a URL a vendor or an operator already
// holds keeps resolving to the PDF that now carries that product. Anything else
// returns null, and every caller maps that to the same 404 an unknown type
// produced before.
export function resolveCollateralGroup(key: string): CollateralGroup | null {
  switch (key) {
    case 'SOUNDBOX':
    case 'SOUNDBOX_IMG':
      return 'SOUNDBOX'
    case 'COLLATERAL':
    case 'STANDEE_IMG':
    case 'STICKER_IMG':
      return 'COLLATERAL'
    default:
      return null
  }
}

// Phase 4 (P4-D5): assemble ONE merged PDF for a delivery group across the whole
// batch, in bank + branch order, by merging the stored per-collateral PDFs (the
// single source of truth is the bytes generated at composition, Task 2). Group
// 'SOUNDBOX' yields the FR-04 step-10 soundbox-only view.
//
// The order comes from buildDispatchPackage's ONE sorted array, which the
// dispatch Excel also serializes, so the merged pages and the sheet rows cannot
// drift into two different bank/branch orders.
//
// Returns null ONLY when the batch has no composed_artifact in that group, and
// for an unrecognized key. If a referenced asset exists as a row but does not
// resolve or is not a readable PDF, that is a FAULT and throws
// AssetResolutionError -- it must NEVER be collapsed into an empty/404, or a
// merchant's label would silently vanish from the dispatch package (Task-3/4
// review, Important). Reads no PII ('print' view).
export async function assembleGroupPdf(
  db: FulfillmentDb,
  assetStore: AssetStore,
  btchId: string,
  key: string,
): Promise<Uint8Array | null> {
  const group = resolveCollateralGroup(key)
  if (group === null) return null
  const order = GROUP_ARTIFACT_TYPES[group]

  const lines = await buildDispatchPackage(db, btchId, 'print')
  const merged = await PDFDocument.create()
  // Fixed metadata so the merged output is deterministic for a fixed input set.
  merged.setCreationDate(new Date(0))
  merged.setModificationDate(new Date(0))
  merged.setProducer('andpay-collateral')
  merged.setCreator('andpay-collateral')

  let matched = 0
  for (const line of lines) {
    // AT MOST ONE artifact per line: the first type present in the group's
    // order. A merchant holding both a standee and a sticker row gets the
    // standee and nothing else, which is one page of shared artwork rather than
    // the same QR printed twice.
    const art = order
      .map((t) => line.artifacts.find((a) => a.artifactType === t))
      .find((a) => a !== undefined)
    if (art === undefined) continue
    matched++
    const rec = await assetStore.getByReference(art.assetReference)
    if (rec === null) {
      throw new AssetResolutionError(`stored collateral not found for a ${art.artifactType} artifact in batch ${btchId}`)
    }
    let src: PDFDocument
    try {
      src = await PDFDocument.load(rec.bytes)
    } catch {
      throw new AssetResolutionError(`stored collateral is not a readable PDF for a ${art.artifactType} artifact in batch ${btchId}`)
    }
    const pages = await merged.copyPages(src, src.getPageIndices())
    for (const pg of pages) merged.addPage(pg)
  }
  if (matched === 0) return null
  return await merged.save()
}
