// The soundbox topic set (spec 03), mirrored here for Glue schema registration.
// Kept in sync with @andpay/bus SOUNDBOX_TOPICS; this project is standalone
// (deployed via cdk) so it does not import from the pnpm workspace.

export interface FactSchema {
  /** The Glue schema name (the fact topic name). */
  name: string
  /** The JSON Schema for the fact payload, registered at FULL compatibility. */
  schema: object
}

// Open content models (additionalProperties allowed) so additive optional fields
// stay FULL-compatible (E3, E8). IDs-only, never PII (S7).
export const FACT_SCHEMAS: FactSchema[] = [
  {
    // Identity merchant fact (spec 05). IDs-and-minimal: NO KYC, PAN, or GSTIN
    // (S7, K3). registered_address is minimized reference identity. Open model,
    // minimal required, so additive optional fields stay FULL-compatible.
    name: 'fct.identity.merchant.v1',
    schema: {
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
  },
  {
    name: 'fct.identity.tenant.v1',
    schema: {
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
  },
  {
    name: 'fct.identity.program.v1',
    schema: {
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
  },
  {
    // The sponsorship-relationship fact (I5). Carries the source-row correlation
    // id so TMS-thin attaches its assignment to the resolved mrch_ without a C4
    // read. The bank_merchant_reference and vpa_hint stay in the resolver (T2).
    name: 'fct.identity.enrollment.v1',
    schema: {
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
  },
  {
    name: 'fct.tms.assignment.v1',
    schema: {
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
      },
      required: ['asgnId', 'demandState'],
    },
  },
  {
    name: 'fct.tms.bank_file_row.v1',
    schema: {
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
  },
  {
    name: 'fct.tms.assignment.ship_to_amended.v1',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        asgnId: { type: 'string' },
        shipToAddress: { type: 'string' },
        amendmentSeq: { type: 'integer' },
      },
      required: ['asgnId', 'amendmentSeq'],
    },
  },
  {
    name: 'fct.tms.assignment.replacement_raised.v1',
    schema: {
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
  },
  {
    name: 'fct.tms.assignment.activated.v1',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        asgnId: { type: 'string' },
        activatedAt: { type: 'string' },
      },
      required: ['asgnId', 'activatedAt'],
    },
  },
  {
    name: 'fct.fulfillment.unit.v1',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        id: { type: 'string' },
        batchId: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['id', 'status'],
    },
  },
]

// Kafka topics to create on MSK (config-as-code; applied by the topic
// provisioning step against the cluster, never a runtime control-plane call).
export const TOPIC_NAMES = [
  'fct.identity.merchant.v1',
  'fct.identity.tenant.v1',
  'fct.identity.program.v1',
  'fct.identity.enrollment.v1',
  'fct.tms.assignment.v1',
  'fct.tms.bank_file_row.v1',
  'fct.tms.assignment.ship_to_amended.v1',
  'fct.tms.assignment.replacement_raised.v1',
  'fct.tms.assignment.activated.v1',
  'fct.fulfillment.batch.v1',
  'fct.fulfillment.unit.v1',
  'fct.fulfillment.shipment.v1',
  'cmd.fulfillment.batch.v1',
]
