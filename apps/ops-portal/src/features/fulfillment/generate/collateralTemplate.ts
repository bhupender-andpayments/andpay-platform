// The card the portal draws, which is the shared geometry plus browser asset URLs.
//
// EVERY MEASUREMENT LIVES IN @andpay/collateral, not here. Two renderers consume
// those numbers, this one for the on-screen proof and services/fulfillment for the
// artifact it stores against each Dispatch ID, and a proof that does not match the
// stored file is worse than no proof. They came off the bank's own approved output
// and cannot be re-derived from anything in the repo, so a second copy would be a
// second thing to keep right with no way to notice when it drifted.
//
// What is genuinely portal-only is where the artwork is FETCHED from: the browser
// pulls it over HTTP from public/, the service reads it out of the asset store. That
// difference, and nothing else, is what this file adds.

import { GSCB_STANDEE, type ArtifactType, type CardGeometry } from './geometry.js'

export {
  ARTIFACT_LABELS,
  ARTIFACT_TYPES,
  GSCB_STANDEE,
  PT_PER_MM,
  SHEET_LAYOUTS,
  artifactTypesFor,
  cardsPerPage,
  fitFontMm,
  mmToPt,
  pageSizeMm,
  slotFor,
  type ArtifactType,
  type CardGeometry,
  type SheetLayout,
  type SheetLayoutId,
  type Slot,
  type TextFieldSpec,
} from './geometry.js'

/** The shared geometry, plus the two artwork files this side fetches by URL. */
export interface CardTemplate extends CardGeometry {
  /** Full-bleed artwork: everything on the card that does not vary by merchant. */
  platePath: string
  /** The bank disc that sits ON the QR, so it is drawn after it. */
  discPath: string
}

const GSCB_STANDEE_TEMPLATE: CardTemplate = {
  ...GSCB_STANDEE,
  platePath: 'collateral/gscb-standee-plate.jpg',
  discPath: 'collateral/gscb-qr-disc.png',
}

// All three types point at the same artwork today because it is the only artwork the
// bank has approved. Giving a type its own card is a new entry here, not a change to
// the renderer.
export const CARD_TEMPLATES: Record<ArtifactType, CardTemplate> = {
  STANDEE_IMG: GSCB_STANDEE_TEMPLATE,
  STICKER_IMG: GSCB_STANDEE_TEMPLATE,
  SOUNDBOX_IMG: GSCB_STANDEE_TEMPLATE,
}
