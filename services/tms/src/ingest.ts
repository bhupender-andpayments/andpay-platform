import { enqueue } from '@andpay/outbox'
import type { TmsDb } from './db.js'
import { rowFactEnvelope, ROW_FACT_TYPE } from './row-fact.js'
import { validateQrVpaFormat, type Tx } from './internal.js'

export interface BankRequestRow {
  fileId: string
  rowNo: number
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
  standeeCount: number
  stickerCount: number
  shipToAddress: string
  vpaHint?: string
}

// Ingest one bank request-file row (S8-untrusted, D116). Validates FORMAT only
// (D117). On accept: stashes the TMS-owned slice in pending_row and emits
// fct.tms.bank_file_row.v1 (identity slice + vpaHint only, S7/S5) in the same
// transaction (E1). Idempotent on {file_id}|{row_no} via the pending_row UNIQUE.
export async function ingestRequestRow(
  db: TmsDb,
  row: BankRequestRow,
  traceId: string,
): Promise<'accepted' | 'duplicate' | 'quarantined'> {
  const correlationId = `${row.fileId}|${row.rowNo}`

  if (!validateQrVpaFormat(row.qrValue, row.vpaValue)) {
    let quarantined = false
    await db.$transaction(async (tx: Tx) => {
      const won = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO quarantine_row (file_id, row_no, raw_row, reason_code)
        VALUES (${row.fileId}, ${row.rowNo}, ${'redacted:bank_request'}, ${'invalid_qr_vpa_format'})
        ON CONFLICT (file_id, row_no) DO NOTHING
        RETURNING id
      `
      if (won.length === 0) return // already quarantined: no second counter bump (check 3)
      quarantined = true
      await tx.$executeRaw`
        INSERT INTO ingest_file (file_id, source, tenant_reference, row_total, row_rejected, status)
        VALUES (${row.fileId}, ${'bank_request'}, ${row.bankReferenceCode}, 1, 1, ${'received'})
        ON CONFLICT (file_id) DO UPDATE SET row_total = ingest_file.row_total + 1, row_rejected = ingest_file.row_rejected + 1
      `
    })
    return quarantined ? 'quarantined' : 'duplicate'
  }

  let outcome: 'accepted' | 'duplicate' = 'duplicate'
  await db.$transaction(async (tx: Tx) => {
    const won = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO pending_row
        (correlation_id, tenant_reference, soundbox, standee_count, sticker_count, qr_value, vpa_value, ship_to_address, status)
      VALUES
        (${correlationId}, ${row.bankReferenceCode}, ${row.soundbox}, ${row.standeeCount}, ${row.stickerCount}, ${row.qrValue}, ${row.vpaValue}, ${row.shipToAddress}, ${'awaiting-identity'})
      ON CONFLICT (correlation_id) DO NOTHING
      RETURNING id
    `
    if (won.length === 0) return // already ingested: no second fact (check 3)
    outcome = 'accepted'

    await enqueue(tx, {
      aggregateType: 'bank_file_row',
      aggregateId: correlationId,
      eventType: ROW_FACT_TYPE,
      partitionKey: `${row.bankReferenceCode}|${row.bankMerchantReference}`,
      payload: rowFactEnvelope({
        payload: {
          bankMerchantReference: row.bankMerchantReference,
          displayName: row.displayName,
          legalName: row.legalName,
          mcc: row.mcc,
          registeredAddress: row.registeredAddress,
          bankReferenceCode: row.bankReferenceCode,
          productType: row.productType,
          vpaHint: row.vpaHint,
        },
        dedupKey: correlationId,
        traceId,
        subject: `${row.bankReferenceCode}|${row.bankMerchantReference}`,
      }),
    })

    await tx.$executeRaw`
      INSERT INTO ingest_file (file_id, source, tenant_reference, row_total, row_accepted, status)
      VALUES (${row.fileId}, ${'bank_request'}, ${row.bankReferenceCode}, 1, 1, ${'received'})
      ON CONFLICT (file_id) DO UPDATE SET row_total = ingest_file.row_total + 1, row_accepted = ingest_file.row_accepted + 1
    `
  })
  return outcome
}
