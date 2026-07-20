import { PrismaClient } from '../generated/client/index.js'

// The Auth-context Prisma client, pinned to the `auth` schema via the
// AUTH_DATABASE_URL ?schema=auth connection parameter (D121, C4). The domain
// functions take an AuthDb by injection so tests and production share one shape.
export type AuthDb = PrismaClient
export { PrismaClient }
