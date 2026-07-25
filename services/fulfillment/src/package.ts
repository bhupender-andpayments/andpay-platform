import { toUuid, fromUuid } from '@andpay/ids'
import type { FulfillmentDb } from './db.js'

// Which adapter function the package projection is being built for. The
// entitlement below is scoped to THIS parameter, never a global field: a
// future print-only adapter passes 'print' and gets no shipping PII (D104
// default-exclude).
export type AdapterFunction = 'print' | 'ship'

export interface PackageLine {
  asgnId: string
  artifactRefs: string[]
  labelDisplayName: string
  labelQr: string
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
 * Entitlement is function-scoped, not a global field: the PRINT view carries
 * the QR label collateral only ({ asgnId, artifactRefs, labelDisplayName,
 * labelQr }) with NO shipping recipient PII (no shipToAddress, no
 * contactName, no mobile key at all - not merely a falsy value). The SHIP
 * view is the print view PLUS the shipping recipient block (shipToAddress,
 * contactName, mobile), sourced from the pending_pool_entry snapshot columns
 * ship_to_address/ship_to_contact_name/ship_to_mobile. The single soundbox
 * print-plus-ship vendor adapter is entitled to the ship view because it
 * dispatches; a future print-only adapter passes 'print' and gets no
 * shipping PII.
 *
 * The package-pull authorize gate (the vendor/ops download surface) lands
 * with the deferred step-9 delivery surface (Field 6); buildDispatchPackage
 * is an internal projection in v1 with no untrusted caller.
 *
 * Redacts nothing to logs here by design (see Task 10 for the log redactor);
 * callers that log this payload are responsible for redaction at that site.
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
      ship_to_address: string
      ship_to_contact_name: string | null
      ship_to_mobile: string | null
    }[]
  >`
    SELECT asgn_id::text AS asgn_id, merchant_display_name, qr_value,
           ship_to_address, ship_to_contact_name, ship_to_mobile
    FROM pending_pool_entry WHERE batch = ${btchUuid}::uuid
  `

  const artifacts = await db.$queryRaw<{ asgn_id: string; asset_reference: string }[]>`
    SELECT asgn_id::text AS asgn_id, asset_reference
    FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid
  `

  const artifactRefsByAsgn = new Map<string, string[]>()
  for (const a of artifacts) {
    const list = artifactRefsByAsgn.get(a.asgn_id) ?? []
    list.push(a.asset_reference)
    artifactRefsByAsgn.set(a.asgn_id, list)
  }

  return entries.map((e): PackageLine => {
    const print: PackageLine = {
      // e.asgn_id is already the native uuid (selected `::text` off a uuid
      // column), so it converts back to wire form via fromUuid, matching the
      // dispatch.ts precedent for asgnIds on the dispatch fact.
      asgnId: fromUuid('asgn', e.asgn_id),
      artifactRefs: artifactRefsByAsgn.get(e.asgn_id) ?? [],
      labelDisplayName: e.merchant_display_name,
      labelQr: e.qr_value,
    }
    if (fn === 'print') return print
    return {
      ...print,
      shipToAddress: e.ship_to_address,
      contactName: e.ship_to_contact_name,
      mobile: e.ship_to_mobile,
    }
  })
}
