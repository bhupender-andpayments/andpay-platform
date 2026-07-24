// The canonical JSON Schemas for the two fulfillment facts (D120), registered
// at FULL compatibility. Open content models (additionalProperties allowed)
// with a minimal required set, so additive optional fields stay
// FULL-compatible (E3, E8). IDs-and-minimal shape (S7): no PII, no snapshot
// names/ship-to/QR/VPA. This is the source of truth; infra mirrors it for the
// deploy-side schema registry.
export const FULFILLMENT_FACT_SCHEMAS: Record<string, object> = {
  'fct.fulfillment.unit.v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      unitId: { type: 'string' }, kind: { type: 'string' }, productType: { type: 'string' },
      manufacturerVndr: { type: 'string' }, status: { type: 'string' },
      deviceSerial: { type: 'string' }, count: { type: 'integer' }, batchId: { type: 'string' },
    },
    required: ['unitId', 'kind', 'status'],
  },
  'fct.fulfillment.batch.v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      btchId: { type: 'string' }, tenantId: { type: 'string' }, programId: { type: 'string' },
      triggerReason: { type: 'string' }, unitCount: { type: 'integer' },
      asgnIds: { type: 'array', items: { type: 'string' } },
    },
    required: ['btchId', 'triggerReason'],
  },
}
