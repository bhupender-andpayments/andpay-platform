// One-time setup: register a bank's APPROVED CARD ARTWORK so generated collateral
// looks like what the bank signed off.
//
// BRD 5.3 FR-03 lists "Template background, font, and element positioning" and
// "Bank logo asset and bank header strip (per bank)" as CONFIGURABLE parameters. So
// the artwork is data, referenced from the bank's own config row, not something
// compiled into this service. Changing a bank's card must not need a deploy.
//
// WHAT THE ARTWORK IS. The bank approved a finished card: blue ground, the header
// carrying its English and Gujarati names, "SCAN & PAY", the frame around the QR,
// the BHIM/UPI/GPay/PhonePe/Paytm marks, and the wave at the foot. All of that is
// identical on every card, so it is supplied as ONE background image with the four
// per-merchant regions erased. The renderer draws only those four over it: shop
// name, QR, UPI ID, and bank-branch. Re-drawing the design in code instead would
// produce something the bank has not approved.
//
// The QR centre mark is a SECOND image, because it has to be drawn after the QR
// rather than under it.
//
// Both images go through the same asset store the bank logo already uses, and their
// returned references are written into the existing `image_templates` JSONB. That
// column is unshaped and read tolerantly, so carrying two more keys needed no
// migration.

import { readFile } from 'node:fs/promises'
import type { AssetStore } from '../storage/asset-store.js'
import { GSCB_STANDEE, PT_PER_MM, type ArtifactType } from '@andpay/collateral'

/** Minimal surface so this runs against a Prisma client or a test double. */
export interface SeedDb {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>
}

export interface SeedArtworkArgs {
  /** Tenant uuid whose bank config rows are updated. */
  tenantUuid: string
  /** Bank codes to apply this artwork to, matched as EXACT strings. */
  bankCodes: readonly string[]
  /** The background image, with the per-merchant regions erased. */
  plate: { path: string; contentType: string }
  /** The mark that sits at the QR's centre, drawn over it. */
  disc: { path: string; contentType: string }
}

export interface SeedArtworkResult {
  plateReference: string
  discReference: string
  /** Bank codes whose config row was updated. */
  updated: string[]
  /** Bank codes with no config row, so nothing was written. */
  missing: string[]
}

const TYPES: readonly ArtifactType[] = ['STANDEE_IMG', 'STICKER_IMG', 'SOUNDBOX_IMG']

/** The per-type key inside image_templates, matching dispatch.ts templateFor. */
function templateKey(artifactType: ArtifactType): string {
  return artifactType.replace('_IMG', '')
}

/**
 * Store the artwork and point the named banks' config rows at it.
 *
 * Idempotent in the way that matters: re-running stores a new asset VERSION and
 * repoints the config rows at it, which is exactly what replacing artwork should do.
 * The old version stays retrievable, so collateral already composed against it can
 * still be resolved.
 */
export async function seedBankArtwork(
  db: SeedDb,
  assetStore: AssetStore,
  args: SeedArtworkArgs,
): Promise<SeedArtworkResult> {
  const plateBytes = new Uint8Array(await readFile(args.plate.path))
  const discBytes = new Uint8Array(await readFile(args.disc.path))

  const plate = await assetStore.put(`bank-artwork/plate/${args.bankCodes[0] ?? 'default'}`, plateBytes, {
    contentType: args.plate.contentType,
    filename: 'card-background',
  })
  const disc = await assetStore.put(`bank-artwork/disc/${args.bankCodes[0] ?? 'default'}`, discBytes, {
    contentType: args.disc.contentType,
    filename: 'qr-centre-mark',
  })

  // The trim the artwork is authored at, carried alongside the references so the
  // renderer's page box and the artwork can never disagree. 99.991 x 180.001 mm is
  // the approved card, measured off the bank's own output.
  const perType: Record<string, unknown> = {}
  for (const t of TYPES) {
    perType[templateKey(t)] = {
      plateRef: plate.reference,
      discRef: disc.reference,
      widthPt: Number((GSCB_STANDEE.trimMm.width * PT_PER_MM).toFixed(2)),
      heightPt: Number((GSCB_STANDEE.trimMm.height * PT_PER_MM).toFixed(2)),
    }
  }

  const updated: string[] = []
  const missing: string[] = []
  for (const bankCode of args.bankCodes) {
    // MERGE rather than replace: a bank may already carry branding or sizing in
    // this column, and overwriting the whole blob to add two keys would silently
    // discard it.
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE bank_composition_config
         SET image_templates = COALESCE(image_templates, '{}'::jsonb) || $1::jsonb,
             updated_at = now()
       WHERE tenant_id = $2::uuid AND bank_code = $3
       RETURNING id::text AS id`,
      JSON.stringify(perType),
      args.tenantUuid,
      bankCode,
    )
    if (rows.length > 0) updated.push(bankCode)
    else missing.push(bankCode)
  }

  return { plateReference: plate.reference, discReference: disc.reference, updated, missing }
}
