// The canonical JSON Schemas for the four identity facts (D120), registered at
// FULL compatibility. Open content models (additionalProperties allowed) with a
// minimal required set, so additive optional fields stay FULL-compatible (E3,
// E8). IDs-and-minimal: NO KYC, PAN, or GSTIN (S7, K3). This is the source of
// truth; infra/aws/lib/topics.ts mirrors it for the deploy-side Glue registry
// (that project is standalone and cannot import from the workspace).

export const IDENTITY_FACT_SCHEMAS: Record<string, object> = {
  'fct.identity.merchant.v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      eventType: { type: 'string' },
      mrchId: { type: 'string' },
      displayName: { type: 'string' },
      legalName: { type: 'string' },
      mcc: { type: 'string' },
      registeredAddress: { type: 'string' },
      activationState: { type: 'string' },
      status: { type: 'string' },
    },
    required: ['mrchId', 'status'],
  },
  'fct.identity.tenant.v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      tnntId: { type: 'string' },
      displayName: { type: 'string' },
      bankReferenceCode: { type: 'string' },
      status: { type: 'string' },
    },
    required: ['tnntId', 'status'],
  },
  'fct.identity.program.v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      progId: { type: 'string' },
      tnntId: { type: 'string' },
      productType: { type: 'string' },
      status: { type: 'string' },
    },
    required: ['progId', 'status'],
  },
  'fct.identity.aggregator.v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      aggrId: { type: 'string' },
      tnntId: { type: 'string' },
      aggregatorCode: { type: 'string' },
      displayName: { type: 'string' },
      status: { type: 'string' },
      isDefault: { type: 'boolean' },
    },
    required: ['aggrId', 'tnntId', 'status'],
  },
  'fct.identity.enrollment.v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      enrollmentId: { type: 'string' },
      mrchId: { type: 'string' },
      progId: { type: 'string' },
      tnntId: { type: 'string' },
      status: { type: 'string' },
      sourceEventId: { type: 'string' },
    },
    required: ['enrollmentId', 'mrchId', 'status'],
  },
}
