// The corpus artifact-type vocabulary, portal-side: the three type ids the
// server stores against each Dispatch ID, and their display labels. This is
// all that survived the client-side card renderer (deleted 21 Aug 2026, when
// the ruling landed that wherever bank data appears it points at master bank
// data): the portal no longer draws cards, it shows the stored ones, so the
// only geometry-free facts it still needs are the names.

export type ArtifactType = 'SOUNDBOX_IMG' | 'STANDEE_IMG' | 'STICKER_IMG'

export const ARTIFACT_LABELS: Record<ArtifactType, string> = {
  STANDEE_IMG: 'Standee',
  STICKER_IMG: 'Sticker',
  SOUNDBOX_IMG: 'Soundbox',
}
