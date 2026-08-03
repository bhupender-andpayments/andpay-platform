import { randomUUID } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { AuthzError } from '@andpay/authz'
import type { Prisma } from '../generated/client/index.js'
import type { AuthDb } from './db.js'
import { enterWriteRole } from './write-context.js'
import { emitAuthzAudit, auditStandalone } from './audit.js'

type Tx = Prisma.TransactionClient

// Spec 14a Task 4: the class-7 vendor_operator STORE PRIMITIVES (Task 3's
// table, under auth_write). Password hashing STAYS in-service (C4): callers
// pass the raw password, never a pre-computed hash, mirroring how
// internal_principal's password is hashed (login.ts uses the same
// @node-rs/argon2 Argon2id verify; provisioning here uses its hash
// counterpart). The higher-level authenticated change-password + admin-reset
// FLOWS (verify current password, refresh-family revoke) are Task 7 and are
// NOT built here; this module only exposes the low-level primitives those
// flows will compose.

export class VendorOperatorDuplicateError extends Error {
  readonly code = 'vendor-operator-duplicate'

  constructor(vndrId: string, username: string) {
    super(`vendor operator already exists for (vndrId=${vndrId}, username=${username})`)
    this.name = 'VendorOperatorDuplicateError'
  }
}

export interface VendorOperatorRow {
  id: string
  vndrId: string
  username: string
  passwordHash: string
  status: string
}

export interface ProvisionVendorOperatorInput {
  // Class-7 vndr_id: stored as the WIRE form (vndr_...) directly, no
  // fromUuid/toUuid round-trip (Task 3 carry-forward).
  vndrId: string
  username: string
  // The raw password (5c): hashed IN-SERVICE below, never stored or logged
  // as-is, never returned.
  password: string
  createdByActor: string
  traceId: string
}

export interface VendorOperatorDeps {
  now?: number
}

// Provisions a new vendor_operator row: hashes the password in-service
// (Argon2id, same primitive login.ts verifies against), inserts under
// auth_write (enterWriteRole FIRST), and co-commits ONE 6e provision record
// on the SAME transaction (IDs/enums only, actor = createdByActor, no
// password material). A duplicate (vndr_id, username) is rejected with a
// typed VendorOperatorDuplicateError; no duplicate operator is created.
export async function provisionVendorOperator(
  db: AuthDb,
  input: ProvisionVendorOperatorInput,
  _deps: VendorOperatorDeps = {},
): Promise<{ id: string }> {
  const id = randomUUID()
  const passwordHash = await argonHash(input.password)

  try {
    await db.$transaction(async (tx) => {
      // Spec 10d Task 6 pattern: enter auth_write FIRST, before any write in
      // this tx (auth has no program predicate, spec 04 field 9, M-role only).
      await enterWriteRole(tx, 'auth_write')
      await tx.vendorOperator.create({
        data: {
          id,
          vndrId: input.vndrId,
          username: input.username,
          passwordHash,
          status: 'ACTIVE',
          createdByActor: input.createdByActor,
        },
      })
      await emitAuthzAudit(tx, {
        principalId: input.createdByActor,
        cls: 7,
        operation: 'vendor_operator:provision',
        decision: 'ALLOW',
        outcome: 'provisioned',
        resourceIds: [id, input.vndrId],
        traceId: input.traceId,
      })
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new VendorOperatorDuplicateError(input.vndrId, input.username)
    }
    throw err
  }

  return { id }
}

// Reads back a vendor_operator by username for the login flow (Task 6).
// A read, not a write: no role switch needed (every other read in this
// service, e.g. internalPrincipal.findUnique in login.ts and
// vendorCredential.findMany in credentials.ts, queries directly).
export async function lookupVendorOperatorByUsername(db: AuthDb, username: string): Promise<VendorOperatorRow | null> {
  const row = await db.vendorOperator.findFirst({ where: { username } })
  if (!row) return null
  return { id: row.id, vndrId: row.vndrId, username: row.username, passwordHash: row.passwordHash, status: row.status }
}

export interface UpdateVendorOperatorPasswordHashInput {
  id: string
  newHash: string
}

// The LOW-LEVEL password-hash-update primitive (used by Task 7's
// authenticated change-password and admin-reset flows). Deliberately takes a
// caller-supplied tx, not a db: the caller has already entered auth_write
// (enterWriteRole FIRST) and will co-commit its own 6e audit (verify-current-
// password / family-revoke are Task 7 concerns, not this primitive's).
export async function updateVendorOperatorPasswordHash(tx: Tx, input: UpdateVendorOperatorPasswordHashInput): Promise<void> {
  await tx.vendorOperator.update({ where: { id: input.id }, data: { passwordHash: input.newHash } })
}

export interface SuspendVendorOperatorInput {
  id: string
  actor: string
  traceId: string
}

// Flips status to 'SUSPENDED' under auth_write, co-committed with its own 6e
// audit record on the same transaction (E1).
export async function suspendVendorOperator(
  db: AuthDb,
  input: SuspendVendorOperatorInput,
  _deps: VendorOperatorDeps = {},
): Promise<void> {
  await db.$transaction(async (tx) => {
    await enterWriteRole(tx, 'auth_write')
    await tx.vendorOperator.update({ where: { id: input.id }, data: { status: 'SUSPENDED' } })
    await emitAuthzAudit(tx, {
      principalId: input.actor,
      cls: 7,
      operation: 'vendor_operator:suspend',
      decision: 'ALLOW',
      outcome: 'suspended',
      resourceIds: [input.id],
      traceId: input.traceId,
    })
  })
}

export interface ChangeVendorPasswordInput {
  operatorId: string
  currentPassword: string
  newPassword: string
  traceId: string
}

// Spec 14a Task 7: the AUTHENTICATED change-password flow (the operator
// changing their own password). Verifies the CURRENT peppered password
// (Argon2id, same primitive vendor-login.ts verifies against) against the
// stored hash before touching anything. A mismatch is a pure DENY with no
// auth write to ride: its 6e is a SYNCHRONOUS STANDALONE durable commit
// BEFORE the throw is observable (the Q1 invariant, same pattern as
// vendor-login.ts's denyThrow). On success, INSIDE ONE auth write tx
// (enterWriteRole FIRST): updates the hash to the new peppered value,
// revokes the operator's OTHER vendor refresh families as a hygiene step
// (principalType:'vendor_operator', mirrors logoutFamily's revoke shape but
// scoped by principalId+principalType rather than a single familyId), and
// co-commits ONE 6e ALLOW (operation 'password-change', actor = the
// operator itself, IDs only, never the raw password).
export async function changeVendorPassword(
  db: AuthDb,
  input: ChangeVendorPasswordInput,
  _deps: VendorOperatorDeps = {},
): Promise<void> {
  const row = await db.vendorOperator.findUnique({ where: { id: input.operatorId } })

  if (!row || !(await argonVerify(row.passwordHash, input.currentPassword))) {
    await auditStandalone(db, {
      principalId: input.operatorId,
      cls: 7,
      operation: 'password-change',
      decision: 'DENY',
      outcome: 'denied',
      reasonCode: 'authn-failed',
      resourceIds: [input.operatorId],
      traceId: input.traceId,
    })
    throw new AuthzError('authn-failed')
  }

  const newHash = await argonHash(input.newPassword)

  await db.$transaction(async (tx) => {
    await enterWriteRole(tx, 'auth_write')
    await updateVendorOperatorPasswordHash(tx, { id: input.operatorId, newHash })
    await tx.refreshToken.updateMany({
      where: { principalId: input.operatorId, principalType: 'vendor_operator', revoked: false },
      data: { revoked: true },
    })
    await emitAuthzAudit(tx, {
      principalId: input.operatorId,
      cls: 7,
      operation: 'password-change',
      decision: 'ALLOW',
      outcome: 'password-changed',
      resourceIds: [input.operatorId],
      traceId: input.traceId,
    })
  })
}

export interface AdminResetVendorPasswordInput {
  operatorId: string
  newPassword: string
  // The class-3 admin's sub, passed by the edge which performs the authz
  // check (this module never authorizes the caller, it only records who the
  // edge told us acted).
  actor: string
  traceId: string
}

// Spec 14a Task 7: the class-3-AUTHORIZED admin reset (no current-password
// check: admin authority, granted upstream by the edge). INSIDE ONE auth
// write tx (enterWriteRole FIRST): updates the hash, revokes the operator's
// vendor refresh families, and co-commits ONE 6e ALLOW (operation
// 'admin-reset', the class-3 actor recorded as principalId, IDs only).
export async function adminResetVendorPassword(
  db: AuthDb,
  input: AdminResetVendorPasswordInput,
  _deps: VendorOperatorDeps = {},
): Promise<void> {
  const newHash = await argonHash(input.newPassword)

  await db.$transaction(async (tx) => {
    await enterWriteRole(tx, 'auth_write')
    await updateVendorOperatorPasswordHash(tx, { id: input.operatorId, newHash })
    await tx.refreshToken.updateMany({
      where: { principalId: input.operatorId, principalType: 'vendor_operator', revoked: false },
      data: { revoked: true },
    })
    await emitAuthzAudit(tx, {
      principalId: input.actor,
      cls: 3,
      operation: 'admin-reset',
      decision: 'ALLOW',
      outcome: 'password-reset',
      resourceIds: [input.operatorId],
      traceId: input.traceId,
    })
  })
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'P2002'
}
