import { PrismaClient } from '../generated/client/index.js'

// The Fulfillment-context Prisma client, pinned to the `fulfillment` schema via
// the FULFILLMENT_DATABASE_URL ?schema=fulfillment connection parameter (C4).
// Domain functions and the SagaEngine take a FulfillmentDb by injection; this
// client can never see another context's schema (C4, T7).
export type FulfillmentDb = PrismaClient
export { PrismaClient }
