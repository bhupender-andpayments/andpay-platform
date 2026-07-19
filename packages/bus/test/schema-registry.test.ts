import { describe, it, expect } from 'vitest'
import { RedpandaSchemaRegistry, SchemaRegistryError } from '../src/index.js'

const SR_URL = process.env.SCHEMA_REGISTRY_URL ?? 'http://localhost:18081'
const registry = new RedpandaSchemaRegistry(SR_URL)
// Unique per run so no earlier run's versions affect this compatibility check.
const subject = `test.compat.merchant-${String(Date.now())}-value`

// Open content models (additionalProperties allowed) so that adding an optional
// field stays forward-compatible; a closed model would reject any added field.
const v1 = {
  type: 'object',
  properties: { id: { type: 'string' }, status: { type: 'string' } },
  required: ['id', 'status'],
}

// Retypes id (string -> number) and drops required status: breaks FULL.
const incompatible = {
  type: 'object',
  properties: { id: { type: 'number' } },
  required: ['id'],
}

// Adds an optional field only, open model: FULL-compatible.
const additive = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['id', 'status'],
}

describe('@andpay/bus RedpandaSchemaRegistry (Decision 120, FULL compat)', () => {
  it('enforces FULL compatibility on registration', async () => {
    await registry.deleteSubject(subject) // best-effort clean slate
    await registry.setCompatibility(subject, 'FULL')

    const r1 = await registry.register(subject, v1)
    expect(r1.id).toBeGreaterThan(0)

    // an incompatible change is a typed rejection, never a silent send
    await expect(registry.register(subject, incompatible)).rejects.toThrow(SchemaRegistryError)

    // an additive optional-field change is accepted
    const r2 = await registry.register(subject, additive)
    expect(r2.id).toBeGreaterThan(0)
  })

  it('reports the compatibility level it set', async () => {
    expect(await registry.getCompatibility(subject)).toBe('FULL')
  })
})
