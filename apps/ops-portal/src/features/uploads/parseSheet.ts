import type { BankRequestRow, BankDamageRow } from '../../api/endpoints.js'

// The client-side 5 MiB upload cap (task 13 brief): checked against
// File.size BEFORE any read/parse/POST happens, so an oversized file never
// touches the network.
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

// jsdom's Blob/File implementation (used under the vitest jsdom test
// environment) does not implement the whatwg Blob.text()/arrayBuffer()
// methods, only FileReader, so this reads via FileReader for portability
// across jsdom and real browsers alike.
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read the file.'))
    reader.readAsText(file)
  })
}

// Minimal hand-rolled CSV parser (no dependency): a comma/newline split with
// double-quote handling ("" escapes a literal quote, a quoted field may
// contain commas or newlines). Good enough for v1 structural parsing; the
// edge is the row validator (D117), not this client, so this deliberately
// does not attempt any business-rule validation.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const len = text.length
  while (i < len) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (ch === '\r') {
      i += 1
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      continue
    }
    field += ch
    i += 1
  }
  // The final field/row for a file with no trailing newline.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// Header row plus data rows -> an array of header-keyed records. Blank
// trailing lines (a lone empty field from a trailing newline) are dropped.
function csvToRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ''))
  if (rows.length === 0) return []
  const header = rows[0]!.map((h) => h.trim())
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {}
    header.forEach((h, idx) => {
      rec[h] = (r[idx] ?? '').trim()
    })
    return rec
  })
}

function parseBoolean(value: string): boolean {
  return /^(true|yes|1)$/i.test(value.trim())
}

function parseCount(value: string): number {
  return Number(value.trim() === '' ? '0' : value.trim())
}

// Parses a bank request CSV into BankRequestRow[], assigning ONE client
// fileId to every row and rowNo = the row's 1-based index. The CSV carries
// only the business columns; fileId/rowNo are never read from it.
export function parseBankRequestSheet(text: string, fileId: string): BankRequestRow[] {
  return csvToRecords(text).map((rec, idx) => {
    const row: BankRequestRow = {
      fileId,
      rowNo: idx + 1,
      bankMerchantReference: rec.bankMerchantReference ?? '',
      displayName: rec.displayName ?? '',
      legalName: rec.legalName ?? '',
      mcc: rec.mcc ?? '',
      registeredAddress: rec.registeredAddress ?? '',
      bankReferenceCode: rec.bankReferenceCode ?? '',
      productType: rec.productType ?? '',
      vpaValue: rec.vpaValue ?? '',
      qrValue: rec.qrValue ?? '',
      soundbox: parseBoolean(rec.soundbox ?? ''),
      standeeCount: parseCount(rec.standeeCount ?? ''),
      stickerCount: parseCount(rec.stickerCount ?? ''),
      shipToAddress: rec.shipToAddress ?? '',
      contactName: rec.contactName ?? '',
      mobile: rec.mobile ?? '',
    }
    const vpaHint = rec.vpaHint ?? ''
    return vpaHint === '' ? row : { ...row, vpaHint }
  })
}

// Parses a damage report CSV into BankDamageRow[], same fileId/rowNo rule.
export function parseBankDamageSheet(text: string, fileId: string): BankDamageRow[] {
  return csvToRecords(text).map((rec, idx) => ({
    fileId,
    rowNo: idx + 1,
    tenantReference: rec.tenantReference ?? '',
    vpaValue: rec.vpaValue ?? '',
    damageReason: rec.damageReason ?? '',
    bankRemarks: rec.bankRemarks ?? '',
    shipToAddress: rec.shipToAddress ?? '',
  }))
}
