// Pure form-state helpers for the three resolve corrections (Task 11). Kept
// free of React so the shape/conversion logic is unit-testable on its own and
// QueuesPage.tsx only wires state to inputs. None of this makes an
// authorization decision (S24/T14): it only builds the wire payload the
// operator typed in; the edge is the sole authority on whether the actor may
// resolve at all.
import type { BankRequestRow, IntakeRow, IntakeSheet, SerializedIntakeRow, QuantityLineIntakeRow } from '../../api/endpoints.js'

// ---------------------------------------------------------------------------
// Quarantine: BankRequestRow correction form. Every field is edited as a
// string (including the two integer counts and rowNo) so a controlled <input>
// never fights a number/string mismatch; `toBankRequestRow` converts on
// submit.
// ---------------------------------------------------------------------------
export interface BankRequestRowForm {
  fileId: string
  rowNo: string
  bankMerchantReference: string
  displayName: string
  legalName: string
  mcc: string
  registeredAddress: string
  bankReferenceCode: string
  productType: string
  vpaValue: string
  qrValue: string
  soundbox: boolean
  standeeCount: string
  stickerCount: string
  shipToAddress: string
  contactName: string
  mobile: string
  // Phase 3 Task 4 (BRD 5.1b): now mandatory at ingest. resolveQuarantineRow
  // re-drives the same ingest path (services/tms/src/ops.ts), so a corrected
  // row missing this bounces straight back into quarantine as
  // 'missing_branch_code' rather than actually resolving. The quarantine row
  // view never carried the original branchCode (S8 reject path persists no
  // more than fileId/rowNo/reasonCode), so this is always a fresh re-key.
  branchCode: string
  vpaHint: string
}

// Pre-fills the two fields the quarantine row view already carries (fileId,
// rowNo); the rest of the original row was never persisted past the
// quarantine reason (S8 reject path), so the operator re-keys it here.
export function emptyBankRequestRowForm(fileId: string, rowNo: number): BankRequestRowForm {
  return {
    fileId,
    rowNo: String(rowNo),
    bankMerchantReference: '',
    displayName: '',
    legalName: '',
    mcc: '',
    registeredAddress: '',
    bankReferenceCode: '',
    productType: '',
    vpaValue: '',
    qrValue: '',
    soundbox: false,
    standeeCount: '0',
    stickerCount: '0',
    shipToAddress: '',
    contactName: '',
    mobile: '',
    branchCode: '',
    vpaHint: '',
  }
}

// Returns null when rowNo/standeeCount/stickerCount do not parse as integers
// (defense-in-depth; the edge validates format too, D117).
export function toBankRequestRow(form: BankRequestRowForm): BankRequestRow | null {
  const rowNo = Number(form.rowNo)
  const standeeCount = Number(form.standeeCount)
  const stickerCount = Number(form.stickerCount)
  if (!Number.isInteger(rowNo) || !Number.isInteger(standeeCount) || !Number.isInteger(stickerCount)) return null
  const base: BankRequestRow = {
    fileId: form.fileId,
    rowNo,
    bankMerchantReference: form.bankMerchantReference,
    displayName: form.displayName,
    legalName: form.legalName,
    mcc: form.mcc,
    registeredAddress: form.registeredAddress,
    bankReferenceCode: form.bankReferenceCode,
    productType: form.productType,
    vpaValue: form.vpaValue,
    qrValue: form.qrValue,
    soundbox: form.soundbox,
    standeeCount,
    stickerCount,
    shipToAddress: form.shipToAddress,
    contactName: form.contactName,
    mobile: form.mobile,
    branchCode: form.branchCode,
  }
  return form.vpaHint.trim() === '' ? base : { ...base, vpaHint: form.vpaHint }
}

// ---------------------------------------------------------------------------
// Status exception resolve (G-SHPT resolved, commit 354aa76 /
// docs/plan/phase7_grounding/G_SHPT_backend_spec.md): the operator picks a
// target status and courier timestamp only. The resolve body's `shptId` is
// NEVER part of this form and is never typed by an operator; QueuesPage.tsx
// sources it exclusively from the row's own CourierStatusExceptionView.shptId
// (already a verified wire id, or null when there is no matching shipment).
// Reintroducing a free-text shptId field here would recreate exactly the
// fabricated-id shape this task's grounding forbids.
// ---------------------------------------------------------------------------
export interface StatusExceptionForm {
  status: string
  courierTimestamp: string
}

export function emptyStatusExceptionForm(defaultStatus: string): StatusExceptionForm {
  return { status: defaultStatus, courierTimestamp: '' }
}
// Intake exception: correctedSheet's dynamic rows editor. Each editable row is
// one of two kinds; deviceQr is edited as a raw JSON string (the wire type is
// an opaque `object`, services/fulfillment/src/intake.ts's isStructurallyValid
// only requires a non-null, non-array object) and parsed on submit.
// ---------------------------------------------------------------------------
export interface SerializedRowForm {
  kind: 'SERIALIZED'
  deviceSerial: string
  productType: string
  deviceQrJson: string
}
export interface QuantityLineRowForm {
  kind: 'QUANTITY_LINE'
  productType: string
  count: string
  qrString: string
}
export type IntakeRowForm = SerializedRowForm | QuantityLineRowForm

export function emptySerializedRowForm(): SerializedRowForm {
  return { kind: 'SERIALIZED', deviceSerial: '', productType: '', deviceQrJson: '{}' }
}
export function emptyQuantityLineRowForm(): QuantityLineRowForm {
  return { kind: 'QUANTITY_LINE', productType: '', count: '0', qrString: '' }
}

// Returns null on anything that would fail isStructurallyValid on the edge
// (empty required strings, non-integer count, or deviceQr that isn't valid
// parseable JSON for a non-null non-array object): the caller surfaces one
// validation message rather than sending a row the edge would reject anyway.
export function toIntakeRow(form: IntakeRowForm): IntakeRow | null {
  if (form.productType.trim() === '') return null
  if (form.kind === 'SERIALIZED') {
    if (form.deviceSerial.trim() === '') return null
    let parsed: unknown
    try {
      parsed = JSON.parse(form.deviceQrJson)
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const row: SerializedIntakeRow = { kind: 'SERIALIZED', deviceSerial: form.deviceSerial, productType: form.productType, deviceQr: parsed }
    return row
  }
  const count = Number(form.count)
  if (!Number.isInteger(count) || form.qrString.trim() === '') return null
  const row: QuantityLineIntakeRow = { kind: 'QUANTITY_LINE', productType: form.productType, count, qrString: form.qrString }
  return row
}

export interface IntakeSheetForm {
  fileId: string
  vndrId: string
  workQueue: string
  rows: IntakeRowForm[]
}

export function emptyIntakeSheetForm(vndrId: string, fileId: string): IntakeSheetForm {
  return { fileId, vndrId, workQueue: '', rows: [] }
}

// Returns null (a single "correction is incomplete" message covers every
// invalid row, plus a missing top-level field) rather than a per-field error
// list: this is a correction form for an ops operator, not the intake upload
// path, where per-row detail already lives in PerRowErrors.
export function toIntakeSheet(form: IntakeSheetForm): IntakeSheet | null {
  if (form.fileId.trim() === '' || form.vndrId.trim() === '' || form.workQueue.trim() === '') return null
  const rows: IntakeRow[] = []
  for (const rowForm of form.rows) {
    const row = toIntakeRow(rowForm)
    if (row === null) return null
    rows.push(row)
  }
  return { fileId: form.fileId, vndrId: form.vndrId, workQueue: form.workQueue, rows }
}
