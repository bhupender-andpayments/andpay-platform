// The canonical JSON Schemas for the five tms facts (D120), registered at FULL
// compatibility. Open content models (additionalProperties allowed) with a
// minimal required set, so additive optional fields stay FULL-compatible (E3,
// E8). IDs-and-minimal shape; PII carried by design (D116/D117) never logged.
// This is the source of truth; infra/aws/lib/topics.ts mirrors it for the
// deploy-side Glue registry (that project is standalone and cannot import the
// workspace).
export const TMS_FACT_SCHEMAS: Record<string, object> = {
  'fct.tms.bank_file_row.v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      bankMerchantReference: { type: 'string' },
      displayName: { type: 'string' },
      legalName: { type: 'string' },
      mcc: { type: 'string' },
      registeredAddress: { type: 'string' },
      bankReferenceCode: { type: 'string' },
      productType: { type: 'string' },
      vpaHint: { type: 'string' },
    },
    required: ['bankMerchantReference', 'bankReferenceCode', 'productType'],
  },
  'fct.tms.assignment.v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      asgnId: { type: 'string' },
      mrchId: { type: 'string' },
      progId: { type: 'string' },
      tnntId: { type: 'string' },
      merchantDisplayName: { type: 'string' },
      merchantLegalName: { type: 'string' },
      merchantMcc: { type: 'string' },
      bankReferenceCode: { type: 'string' },
      bankDisplayName: { type: 'string' },
      shipToAddress: { type: 'string' },
      qrValue: { type: 'string' },
      vpaValue: { type: 'string' },
      soundbox: { type: 'boolean' },
      standeeCount: { type: 'integer' },
      stickerCount: { type: 'integer' },
      billable: { type: 'boolean' },
      demandState: { type: 'string' },
      sourceEventId: { type: 'string' },
      // spec 06a: recipient contact snapshot, OPTIONAL (FULL compat, no v2).
      contactName: { type: 'string' },
      mobile: { type: 'string' },
      // Phase 3 Task 4: Branch Code snapshot, OPTIONAL (FULL compat, no v2).
      branchCode: { type: 'string' },
    },
    required: ['asgnId', 'demandState'],
  },
  'fct.tms.assignment.ship_to_amended.v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      asgnId: { type: 'string' },
      shipToAddress: { type: 'string' },
      amendmentSeq: { type: 'integer' },
      // spec 06a: recipient contact block on the amend, OPTIONAL (FULL compat).
      contactName: { type: 'string' },
      mobile: { type: 'string' },
    },
    required: ['asgnId', 'amendmentSeq'],
  },
  'fct.tms.assignment.replacement_raised.v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      asgnId: { type: 'string' },
      replacedAsgnId: { type: 'string' },
      damageReason: { type: 'string' },
      bankRemarks: { type: 'string' },
    },
    required: ['asgnId', 'replacedAsgnId'],
  },
  'fct.tms.assignment.activated.v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      asgnId: { type: 'string' },
      activatedAt: { type: 'string' },
    },
    required: ['asgnId', 'activatedAt'],
  },
}
