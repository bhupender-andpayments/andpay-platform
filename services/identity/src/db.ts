import { PrismaClient } from '../generated/client/index.js'

// The Identity-context Prisma client, pinned to the `identity` schema via the
// IDENTITY_DATABASE_URL ?schema=identity connection parameter (C4). Domain
// functions take an IdentityDb by injection so tests and production share one
// shape. This client can never see another context's schema (C4, T7).
export type IdentityDb = PrismaClient
export { PrismaClient }
