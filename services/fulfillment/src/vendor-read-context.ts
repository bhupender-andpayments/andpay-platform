import type { Prisma } from '../generated/client/index.js'

type Tx = Prisma.TransactionClient

// Spec 14b: the vendor-axis read-scope entry point (the sibling of
// read-context.ts's enterReadScope). Every vendor read calls this FIRST,
// inside its own transaction, before any SELECT. role is a compile-time
// constant (never user input), safe to inline. vndrUuid is the NATIVE uuid
// derived server-side from the authenticated scope.vndr wire id via
// toUuid('vndr', ...) (the caller does the conversion, D99), bound through a
// $queryRaw tagged template. Under fulfillment_vendor_read the *_vendor_read
// RESTRICTIVE policies (Task 2) then gate every SELECT on the print_vndr axis,
// fail-closed on an unset app.vndr_id.
export async function enterVendorReadScope(tx: Tx, vndrUuid: string): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_vendor_read`)
  await tx.$queryRaw`SELECT set_config('app.vndr_id', ${vndrUuid}, true)`
}
