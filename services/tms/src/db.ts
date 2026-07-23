import { PrismaClient } from '../generated/client/index.js'

// The TMS-context Prisma client, pinned to the `tms` schema via the
// TMS_DATABASE_URL ?schema=tms connection parameter (C4). Domain functions take
// a TmsDb by injection so tests and production share one shape. This client can
// never see another context's schema (C4, T7).
export type TmsDb = PrismaClient
export { PrismaClient }
