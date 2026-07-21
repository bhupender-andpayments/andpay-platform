import { describe, it, expect } from 'vitest'
import { RedpandaSchemaRegistry, SchemaRegistryError } from '@andpay/bus'
import { IDENTITY_FACT_SCHEMAS } from '../src/fact-schemas.js'

// Check 4 (load-bearing): the fct.identity.merchant.v1 JSON Schema registers at
// FULL compatibility (D120); a type change and a new required field are rejected
// (raw registry 409 as a typed error), an additive optional field is accepted;
// and the schema names NO KYC/PAN/GSTIN field (S7, K3). Reuses the spec-03
// registry machinery against the local Redpanda registry.
const SR_URL = process.env.SCHEMA_REGISTRY_URL ?? 'http://localhost:18081'
const registry = new RedpandaSchemaRegistry(SR_URL)
const subject = `identity.merchant.compat-${String(Date.now())}-value`

const merchantSchema = IDENTITY_FACT_SCHEMAS['fct.identity.merchant.v1'] as {
  $schema?: string
  type: string
  properties: Record<string, { type: string }>
  required: string[]
}

// Retypes mrchId string -> number: breaks FULL.
const typeChange = {
  ...merchantSchema,
  properties: { ...merchantSchema.properties, mrchId: { type: 'number' } },
}
// Adds a new REQUIRED field: breaks FULL backward compatibility.
const newRequired = {
  ...merchantSchema,
  properties: { ...merchantSchema.properties, region: { type: 'string' } },
  required: [...merchantSchema.required, 'region'],
}
// Adds an optional field only (open model): FULL-compatible.
const additive = {
  ...merchantSchema,
  properties: { ...merchantSchema.properties, note: { type: 'string' } },
}

describe('fct.identity.merchant.v1 schema FULL compat (check 4, D120)', () => {
  it('registers at FULL, rejects a type change and a new required field, accepts an additive optional field', async () => {
    await registry.deleteSubject(subject) // best-effort clean slate
    await registry.setCompatibility(subject, 'FULL')

    const r1 = await registry.register(subject, merchantSchema)
    expect(r1.id).toBeGreaterThan(0)

    await expect(registry.register(subject, typeChange)).rejects.toThrow(SchemaRegistryError)
    await expect(registry.register(subject, newRequired)).rejects.toThrow(SchemaRegistryError)

    const r2 = await registry.register(subject, additive)
    expect(r2.id).toBeGreaterThan(0)
  })

  it('reports FULL as the compatibility level it set', async () => {
    expect(await registry.getCompatibility(subject)).toBe('FULL')
  })

  it('names no KYC, PAN, or GSTIN field (S7, K3)', () => {
    const json = JSON.stringify(merchantSchema).toLowerCase()
    for (const forbidden of ['kyc', 'pan', 'gstin', 'aadhaar', 'aadhar']) {
      expect(json.includes(forbidden), `merchant schema must not name ${forbidden}`).toBe(false)
    }
  })
})
