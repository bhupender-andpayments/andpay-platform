import { PrismaClient } from '../generated/client/index.js'

// The Analytics-context Prisma client, pinned to the `analytics` schema via the
// ANALYTICS_DATABASE_URL ?schema=analytics connection parameter (C4). Domain
// functions take an AnalyticsDb by injection so tests and production share one
// shape. This client can never see another context's schema (C4, T7).
export type AnalyticsDb = PrismaClient
export { PrismaClient }
