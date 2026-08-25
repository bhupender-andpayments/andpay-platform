import ExcelJS from 'exceljs'
import { PDFDocument } from 'pdf-lib'
import { toUuid, fromUuid } from '@andpay/ids'
import type { FulfillmentDb } from './db.js'
import type { AssetStore } from './storage/asset-store.js'
import { decodeBankQrPayload } from '@andpay/bank-qr'
import { imposeGridRun, type GridCard } from './impose.js'

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
  // Task 6 (2026-08-11 dispatch-group split): the Task 5 column, carried
  // straight through so callers key sheet membership and artifact selection
  // on it. NULL means a legacy, pre-split combined row; see excelLinesFor's
  // W-5 paragraph below for what that means downstream.
  dispatchGroup: string | null
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
      dispatch_group: string | null
      soundbox: boolean
      standee_count: number
      sticker_count: number
      merchant_legal_name: string
    }[]
  >`
    SELECT asgn_id::text AS asgn_id, merchant_display_name, merchant_legal_name, qr_value,
           bank_reference_code, branch_code, dispatch_group, soundbox, standee_count, sticker_count,
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
      dispatchGroup: e.dispatch_group,
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

// W-6: the two press capabilities. GRID_3X2 exists because some presses cannot
// impose; it is not a preference.
export type PrintLayout = 'ONE_PER_PAGE' | 'GRID_3X2'

/**
 * The bound print vendor's press layout for a batch, resolved at DOWNLOAD time.
 *
 * ONE function, because the merged PDF and the dispatch Excel must never
 * disagree about which layout a batch is in: the PDF decides whether copies are
 * pre-imposed and the sheet decides whether its count columns read as an
 * instruction or as reconciliation, and a batch where those two answers differ
 * would tell the vendor to print the run twice.
 *
 * No bound vendor (print_vndr NULL, or a batch row a test database never seeds
 * at all) falls back to ONE_PER_PAGE, the original behavior.
 */
export async function readBatchPrintLayout(db: FulfillmentDb, btchId: string): Promise<PrintLayout> {
  const rows = await db.$queryRaw<{ print_layout: string }[]>`
    SELECT v.print_layout FROM batch b JOIN vndr v ON v.id = b.print_vndr
    WHERE b.id = ${toUuid(btchId)}::uuid
  `
  return rows[0]?.print_layout === 'GRID_3X2' ? 'GRID_3X2' : 'ONE_PER_PAGE'
}

// D-11 RULED 13 Aug 2026: GRID_3X2 is a SANCTIONED EXCEPTION to "the vendor
// prints it N times", for presses that cannot impose. The exception is only
// safe if the sheet and the sheets-of-paper agree on who owns the copy count,
// so on a grid batch these two headers say outright that the run is already
// built. Before this, a grid batch shipped pre-imposed cells AND a bare count
// column, and a vendor honoring both would have printed the run N times over.
//
// Renaming is safe against the W-5 return round trip by construction: the
// return adapter reads Dispatch ID, Device ID, AWB and Courier by name and
// ignores every other column, so these two headers are ours to word.
const COUNT_HEADERS: Record<PrintLayout, { standee: string; sticker: string }> = {
  ONE_PER_PAGE: { standee: 'Standee Count', sticker: 'Sticker Count' },
  GRID_3X2: { standee: 'Standee Count (already imposed)', sticker: 'Sticker Count (already imposed)' },
}

const dispatchColumns = (layout: PrintLayout): { header: string; key: string }[] => [
  // D17 (Phase 4): the batch the sheet belongs to, named ON the sheet. A print
  // vendor holds several batches' files at once and the filename was the only
  // thing that said which was which, so a renamed or forwarded attachment lost
  // the only link back to a batch. It is FIRST because it is the coarsest key
  // on the row: bank, branch and dispatch id all live inside one batch.
  //
  // Same value in every row of a file by construction (one file is one batch),
  // which is the point: any row a human or a spreadsheet filter lifts out of
  // the sheet still carries its batch.
  { header: 'Batch ID', key: 'btchId' },
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
  // A soundbox has no quantity of its own (one per merchant in either layout),
  // so only these two carry a copy count and only these two need qualifying.
  { header: COUNT_HEADERS[layout].standee, key: 'standeeCount' },
  { header: COUNT_HEADERS[layout].sticker, key: 'stickerCount' },
  { header: 'QR', key: 'labelQr' },
  { header: 'Ship To', key: 'shipToAddress' },
  { header: 'Contact', key: 'contactName' },
  { header: 'Mobile', key: 'mobile' },
  { header: 'Artifact Refs', key: 'artifactRefs' },
  // W-5 round trip: the sheet we send IS the return template. The vendor
  // fills these three; the headers are exactly the return parser's own
  // (return-sheet-adapter.ts HEADERS), so the file we send is the file that
  // comes back. On the Collateral sheet Device ID stays blank by contract:
  // the sheet's shape teaches the serial-less rule.
  { header: 'Device ID', key: 'fillDeviceId' },
  { header: 'AWB', key: 'fillAwb' },
  { header: 'Courier', key: 'fillCourier' },
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
//
// W-5 (Task 6, 2026-08-11 dispatch-group split): membership now keys on
// PackageLine.dispatchGroup FIRST, falling back to the rules above ONLY when
// dispatchGroup is null. A Task 5 split row already knows which one delivery
// group it belongs to, so its own group tag decides membership outright, even
// if its soundbox/standeeCount/stickerCount happen to disagree with the
// combined-row heuristic (they describe only THAT group's products, never the
// other group's). A null-group row is a legacy, pre-split combined row, and
// for that row alone the original flag-based rule keeps deciding membership,
// unchanged, so every pre-split batch still lands exactly where it always
// has.
export function excelLinesFor(lines: PackageLine[], group: CollateralGroup): PackageLine[] {
  if (group === 'SOUNDBOX') return lines.filter((l) => l.dispatchGroup === 'SOUNDBOX' || (l.dispatchGroup === null && l.soundbox))
  return lines.filter(
    (l) => l.dispatchGroup === 'COLLATERAL' || (l.dispatchGroup === null && (l.standeeCount >= 1 || l.stickerCount >= 1 || !l.soundbox)),
  )
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
//
// `btchId` is the WIRE form (`btch_...`) of the batch these lines came from. It
// is a parameter and not a PackageLine field because it is a property of the
// FILE, not of a row: one call is one batch, so a per-line field would only make
// it possible to build a sheet whose rows disagree about which batch they are.
// It is REQUIRED, and it sits before `layout` for that reason: an optional batch
// id is a door that can ship a sheet with a blank Batch ID column (D17), which
// is the very failure the column exists to prevent.
//
// `layout` is the bound print vendor's press (readBatchPrintLayout), and it
// changes ONLY the wording of the two count headers, never the column set, the
// order, or any cell. It defaults to ONE_PER_PAGE so this stays a pure function
// a test can call without a batch, and so a caller that has no batch context
// gets the original sheet rather than a wrong claim about imposition.
export async function dispatchGroupXlsx(
  lines: PackageLine[],
  group: CollateralGroup,
  btchId: string,
  layout: PrintLayout = 'ONE_PER_PAGE',
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(GROUP_SHEET_NAMES[group])
  ws.columns = dispatchColumns(layout)
  writeRows(ws, excelLinesFor(lines, group), btchId)
  const arrayBuf = await wb.xlsx.writeBuffer()
  return Buffer.from(arrayBuf)
}

/**
 * The dispatch Excel for one delivery group, resolved end to end from the batch.
 *
 * ONE function for BOTH doors, the ops download and the vendor pull, because the
 * count-column wording depends on the bound vendor's press and a per-door layout
 * argument is a per-door chance to forget it. A door that forgot would hand a
 * grid press a pre-imposed run AND a bare copy count, which is the exact defect
 * the D-11 exception ruling closes. There is now no layout argument at a door to
 * get wrong.
 *
 * `dispatchGroupXlsx` stays exported and pure for the tests that build sheets
 * from hand-made lines with no batch behind them.
 */
export async function buildDispatchGroupXlsx(
  db: FulfillmentDb,
  btchId: string,
  group: CollateralGroup,
  fn: AdapterFunction,
): Promise<Buffer> {
  const lines = await buildDispatchPackage(db, btchId, fn)
  return await dispatchGroupXlsx(lines, group, btchId, await readBatchPrintLayout(db, btchId))
}

// Phase 4 (P4-D5): serialize the (already bank+branch-sorted) package lines.
// Shared by the vendor pull and the ops download so both surfaces produce the
// SAME sorted sheets. artifactRefs are joined into one cell; image BYTES are
// delivered as the per-type PDFs, not embedded here.
function writeRows(ws: ExcelJS.Worksheet, lines: PackageLine[], btchId: string): void {
  for (const l of lines) {
    ws.addRow({
      // The one batch id, repeated per row: a spreadsheet has no file-level
      // field a filter or a copied selection carries with it, so the only place
      // this survives being lifted out of the sheet is the row itself (D17).
      btchId,
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
      // The three template cells: always blank going out, on both sheets. The
      // vendor fills them in and returns the SAME file, and parseReturnWorkbook
      // reads these exact headers back (W-5 round trip).
      fillDeviceId: '',
      fillAwb: '',
      fillCourier: '',
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
// ONE dispatch's stored card, by (batch, assignment, type): the bytes compose
// wrote, carrying the aggregator's own logo from the asset store, so the
// portal's on-screen proof can show the ACTUAL stored artifact instead of
// re-drawing a lookalike client-side (ruled 21 Aug 2026: wherever bank data
// appears it points at master bank data, backend plus asset store). Same
// superseded_by IS NULL rule as the delivery path above: after a recompose the
// replacement row is the only card the vendor will ever print. Returns null
// for an unknown id or type (a 404 upstream); an existing row whose reference
// does not resolve throws AssetResolutionError, exactly like assembleGroupPdf,
// because that is a fault and not an absence.
export async function readComposedArtifact(
  db: FulfillmentDb,
  assetStore: AssetStore,
  btchId: string,
  asgnId: string,
  artifactType: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!['SOUNDBOX_IMG', 'STANDEE_IMG', 'STICKER_IMG'].includes(artifactType)) return null
  let btchUuid: string
  let asgnUuid: string
  try {
    btchUuid = toUuid(btchId)
    asgnUuid = toUuid(asgnId)
  } catch {
    return null
  }
  const rows = await db.$queryRaw<{ asset_reference: string }[]>`
    SELECT asset_reference FROM composed_artifact
    WHERE btch_id = ${btchUuid}::uuid AND asgn_id = ${asgnUuid}::uuid
      AND artifact_type = ${artifactType} AND superseded_by IS NULL
    LIMIT 1
  `
  const reference = rows[0]?.asset_reference
  if (reference === undefined) return null
  const rec = await assetStore.getByReference(reference)
  if (rec === null) {
    throw new AssetResolutionError(`stored collateral not found for a ${artifactType} artifact in batch ${btchId}`)
  }
  return { bytes: rec.bytes, contentType: rec.meta.contentType }
}

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
//
// W-6 (Task 14, 2026-08-11 dispatch-group split): assembly branches on the
// BOUND print vendor's press layout, read HERE, at assembly time, never at
// composition time. composed_artifact stays exactly the 1-up PDFs Task 2
// always rendered; flipping a vendor's layout setting (ops.ts
// setVendorPrintLayout) changes the very next download with no re-render and
// no backfill. ONE_PER_PAGE (the default, and every batch with no bound
// vendor) keeps the merge loop below byte-for-byte as it always was.
// GRID_3X2 imposes the SAME stored bytes onto Task 13's 3x2 sheet instead.
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

  // W-6: the layout is the BOUND print vendor's press capability, read at
  // assembly time. Stored artifacts are 1-up and never re-rendered for a
  // layout change: flipping the vendor's setting changes the next download.
  // Shared with the Excel builder through readBatchPrintLayout, so the sheet
  // and the sheets of paper cannot disagree about who owns the copy count.
  const layout = await readBatchPrintLayout(db, btchId)

  if (layout === 'GRID_3X2') {
    return await assembleGridGroupPdf(merged, assetStore, btchId, group, lines)
  }

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

// GRID_3X2 material runs (W-6): a sheet never mixes standee board with
// sticker adhesive, so each material is its own imposeGridRun call, which
// always starts a fresh sheet. SOUNDBOX is a single run, copies 1 for every
// line holding a SOUNDBOX_IMG artifact (a soundbox has no quantity of its
// own; the artifact's presence IS the demand). COLLATERAL is TWO runs,
// standee first then sticker, mirroring STANDEE_IMG before STICKER_IMG in
// GROUP_ARTIFACT_TYPES above, copies taken from the line's OWN
// standeeCount/stickerCount. A line lacking that run's artifact, or holding
// it with count 0, contributes nothing to that run; a legacy (pre-split)
// line carrying both artifacts contributes to BOTH runs, because in grid mode
// there is no ONE-artifact-per-line de-dup: standee and sticker are two
// distinct physical print runs, and its two counts are both real demand.
async function assembleGridGroupPdf(
  merged: PDFDocument,
  assetStore: AssetStore,
  btchId: string,
  group: CollateralGroup,
  lines: PackageLine[],
): Promise<Uint8Array | null> {
  let placed = 0
  if (group === 'SOUNDBOX') {
    const cards = await buildGridCards(assetStore, btchId, lines, 'SOUNDBOX_IMG', () => 1)
    placed = await imposeGridRun(merged, cards)
  } else {
    const standeeCards = await buildGridCards(assetStore, btchId, lines, 'STANDEE_IMG', (l) => l.standeeCount)
    const stickerCards = await buildGridCards(assetStore, btchId, lines, 'STICKER_IMG', (l) => l.stickerCount)
    placed = await imposeGridRun(merged, standeeCards)
    placed += await imposeGridRun(merged, stickerCards)
  }
  if (placed === 0) return null
  return await merged.save()
}

// Resolves ONE material run's cards by walking `lines` in the package's own
// sorted (bank, branch, dispatch id) order, taking the artifact of exactly
// `artifactType` off each line whose copiesFor() is positive. Same
// asset-resolution contract as the ONE_PER_PAGE loop above: an unresolvable
// reference is a storage FAULT and throws AssetResolutionError, never a skip,
// because a merchant's label must never silently vanish from the print run.
async function buildGridCards(
  assetStore: AssetStore,
  btchId: string,
  lines: PackageLine[],
  artifactType: string,
  copiesFor: (line: PackageLine) => number,
): Promise<GridCard[]> {
  const cards: GridCard[] = []
  for (const line of lines) {
    const copies = copiesFor(line)
    if (copies <= 0) continue
    const art = line.artifacts.find((a) => a.artifactType === artifactType)
    if (art === undefined) continue
    const rec = await assetStore.getByReference(art.assetReference)
    if (rec === null) {
      throw new AssetResolutionError(`stored collateral not found for a ${artifactType} artifact in batch ${btchId}`)
    }
    // The NOT-READABLE half of the contract (Task 14 review, Important): the
    // ONE_PER_PAGE loop converts a corrupt-PDF parse failure into
    // AssetResolutionError; without this probe the grid path would surface a
    // raw pdf-lib error from inside the imposer instead. The parse result is
    // discarded (the imposer embeds from bytes); the double parse is the
    // price of failing with the domain error before any sheet is built.
    try {
      await PDFDocument.load(rec.bytes)
    } catch {
      throw new AssetResolutionError(`stored collateral is not a readable PDF for a ${artifactType} artifact in batch ${btchId}`)
    }
    cards.push({ bytes: rec.bytes, copies })
  }
  return cards
}
