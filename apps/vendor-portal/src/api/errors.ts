export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`api ${status}`)
    this.name = 'ApiError'
  }
}
