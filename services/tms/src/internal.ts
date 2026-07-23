import type { Prisma } from '../generated/client/index.js'

// Interactive-transaction client: the full client without the top-level
// transaction and lifecycle methods (mirrors identity/src/project.ts).
export type Tx = Prisma.TransactionClient

// The inbox consumer identity for effectively-once effects (E6).
export const CONSUMER = 'tms'

// SET LOCAL app.program_id via set_config (the parameterizable form). The
// assignment RLS policy write-gates on this (07.B); reads stay open. Allowed by
// the architecture guard because the literal is 'app.program_id', not
// 'search_path'.
export async function setProgramContext(tx: Tx, programUuid: string): Promise<void> {
  await tx.$queryRaw`SELECT set_config('app.program_id', ${programUuid}, true)`
}

// D117: v1 validates FORMAT only; TMS never mints, derives, or alters the value
// (T2). A VPA is user@psp; a QR string is a non-empty upi: or upi:// payload.
export function validateQrVpaFormat(qr: string, vpa: string): boolean {
  const vpaOk = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/.test(vpa)
  const qrOk = qr.length > 0 && /^upi:/i.test(qr)
  return vpaOk && qrOk
}
