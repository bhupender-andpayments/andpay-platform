/** Thrown by the schema-registry adapter on a rejected or failed call. */
export class SchemaRegistryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message)
    this.name = 'SchemaRegistryError'
  }
}

/** Thrown by the publisher when a message cannot be published. */
export class BusError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BusError'
  }
}
