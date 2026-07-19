import { SchemaRegistryError } from './errors.js'

export type CompatLevel =
  | 'NONE'
  | 'BACKWARD'
  | 'BACKWARD_TRANSITIVE'
  | 'FORWARD'
  | 'FORWARD_TRANSITIVE'
  | 'FULL'
  | 'FULL_TRANSITIVE'

/**
 * The schema-registry seam (Decision 120). JSON Schemas are versioned and
 * compatibility is enforced at registration. This port hides the vendor so no
 * registry-vendor type leaks inland (T11): the local dev adapter targets the
 * Redpanda/Confluent REST API, the production adapter targets AWS Glue, both
 * behind this interface.
 */
export interface SchemaRegistryPort {
  setCompatibility(subject: string, level: CompatLevel): Promise<void>
  getCompatibility(subject: string): Promise<CompatLevel>
  register(subject: string, schema: object): Promise<{ id: number }>
  checkCompatibility(subject: string, schema: object): Promise<boolean>
  latestSchema(subject: string): Promise<object>
  deleteSubject(subject: string): Promise<void>
}

const CONTENT_TYPE = 'application/vnd.schemaregistry.v1+json'

/**
 * Confluent-compatible REST adapter (Redpanda's built-in registry in dev). An
 * incompatible registration returns a non-2xx and is raised as a typed
 * SchemaRegistryError carrying the raw registry body, never a silent send.
 */
export class RedpandaSchemaRegistry implements SchemaRegistryPort {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  async setCompatibility(subject: string, level: CompatLevel): Promise<void> {
    const res = await fetch(this.url(`/config/${encodeURIComponent(subject)}`), {
      method: 'PUT',
      headers: { 'content-type': CONTENT_TYPE },
      body: JSON.stringify({ compatibility: level }),
    })
    if (!res.ok) {
      throw new SchemaRegistryError(`setCompatibility ${String(res.status)}`, res.status, await res.text())
    }
  }

  async getCompatibility(subject: string): Promise<CompatLevel> {
    const res = await fetch(this.url(`/config/${encodeURIComponent(subject)}`))
    if (!res.ok) {
      throw new SchemaRegistryError(`getCompatibility ${String(res.status)}`, res.status, await res.text())
    }
    const body = (await res.json()) as { compatibilityLevel: CompatLevel }
    return body.compatibilityLevel
  }

  async register(subject: string, schema: object): Promise<{ id: number }> {
    const res = await fetch(this.url(`/subjects/${encodeURIComponent(subject)}/versions`), {
      method: 'POST',
      headers: { 'content-type': CONTENT_TYPE },
      body: JSON.stringify({ schemaType: 'JSON', schema: JSON.stringify(schema) }),
    })
    const body = await res.text()
    if (!res.ok) {
      throw new SchemaRegistryError(
        `schema registration rejected (${String(res.status)}): ${body}`,
        res.status,
        body,
      )
    }
    return { id: (JSON.parse(body) as { id: number }).id }
  }

  async checkCompatibility(subject: string, schema: object): Promise<boolean> {
    const res = await fetch(
      this.url(`/compatibility/subjects/${encodeURIComponent(subject)}/versions/latest`),
      {
        method: 'POST',
        headers: { 'content-type': CONTENT_TYPE },
        body: JSON.stringify({ schemaType: 'JSON', schema: JSON.stringify(schema) }),
      },
    )
    if (!res.ok) {
      throw new SchemaRegistryError(`checkCompatibility ${String(res.status)}`, res.status, await res.text())
    }
    return ((await res.json()) as { is_compatible: boolean }).is_compatible
  }

  async latestSchema(subject: string): Promise<object> {
    const res = await fetch(this.url(`/subjects/${encodeURIComponent(subject)}/versions/latest`))
    if (!res.ok) {
      throw new SchemaRegistryError(`latestSchema ${String(res.status)}`, res.status, await res.text())
    }
    const body = (await res.json()) as { schema: string }
    return JSON.parse(body.schema) as object
  }

  async deleteSubject(subject: string): Promise<void> {
    const res = await fetch(this.url(`/subjects/${encodeURIComponent(subject)}`), {
      method: 'DELETE',
    })
    if (!res.ok && res.status !== 404) {
      throw new SchemaRegistryError(`deleteSubject ${String(res.status)}`, res.status, await res.text())
    }
  }
}
