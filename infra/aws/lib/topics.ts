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
    name: 'fct.identity.merchant.v1',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'fct.tms.assignment.v1',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        id: { type: 'string' },
        merchantId: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['id', 'status'],
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
  'fct.tms.assignment.v1',
  'fct.fulfillment.batch.v1',
  'fct.fulfillment.unit.v1',
  'fct.fulfillment.shipment.v1',
  'cmd.fulfillment.batch.v1',
]
