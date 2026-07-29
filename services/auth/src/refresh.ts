import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { AuthzError } from '@andpay/authz'
import type { AuthDb } from './db.js'
import { enterWriteRole } from './write-context.js'

// Refresh tokens are opaque (never a JWT), hashed at rest; only the hash is
// stored and it is the lookup path.
function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface IssueFamilyDeps {
  db: AuthDb
  idleSec: number
  absoluteSec: number
  now?: number
}

// Start a new D3 refresh-token family (6b): opaque, hashed at rest, client-bound,
// with independent idle and absolute bounds.
export async function issueRefreshFamily(
  principalId: string,
  clientBind: string,
  deps: IssueFamilyDeps,
): Promise<{ refreshToken: string; familyId: string }> {
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  const token = newOpaqueToken()
  const familyId = randomUUID()
  // Spec 10d Task 6 NAMED Fork-E EXCEPTION: this was a single non-transactional
  // `deps.db.refreshToken.create(...)` call (no db.$transaction). SET LOCAL
  // ROLE only binds for the lifetime of one transaction, so entering
  // auth_write requires a tx to enter it into; this wraps the same single
  // create in deps.db.$transaction with enterWriteRole as its first
  // statement. This is a shape-change (a bare call became a transaction), not
  // a byte-identical wrap; the returned value and all refresh-family
  // semantics (spec 04 check 3) are unchanged (proved in test/write_role.test.ts).
  await deps.db.$transaction(async (tx) => {
    await enterWriteRole(tx, 'auth_write')
    await tx.refreshToken.create({
      data: {
        id: randomUUID(),
        tokenHash: hashToken(token),
        familyId,
        principalId,
        clientBind,
        issuedAt: new Date(now * 1000),
        idleExpires: new Date((now + deps.idleSec) * 1000),
        absoluteExpires: new Date((now + deps.absoluteSec) * 1000),
      },
    })
  })
  return { refreshToken: token, familyId }
}

export interface RotateDeps {
  db: AuthDb
  idleSec: number
  now?: number
}

// One-time-use rotation with family-wide revocation on reuse (6b). A presented
// token that was already rotated (used) is an anti-replay signal: the ENTIRE
// family is revoked. Idle and absolute bounds are enforced; absolute is
// family-wide and does not extend on rotation.
export async function rotateRefresh(
  presented: string,
  deps: RotateDeps,
): Promise<{ refreshToken: string; principalId: string; familyId: string }> {
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  const presentedHash = hashToken(presented)

  const row = await deps.db.refreshToken.findUnique({ where: { tokenHash: presentedHash } })
  if (!row) throw new AuthzError('refresh-unknown')
  if (row.revoked) throw new AuthzError('refresh-revoked')
  if (row.used) {
    // Reuse of a rotated token: revoke the ENTIRE family (6b anti-replay). This
    // MUST be a committed write, so it runs outside the throwing path (a throw
    // inside an interactive transaction would roll the revoke back).
    // Spec 10d Task 6 completion pass NAMED Fork-E EXCEPTION: the revoke is
    // wrapped in its OWN committing transaction, with enterWriteRole as its
    // first statement, and the throw happens AFTER that transaction has
    // returned (i.e. committed). This runs the revoke under auth_write while
    // preserving commit-before-throw: the tx commits the revoke, then control
    // returns here and the throw happens outside the tx, so there is no
    // rollback of the security-critical anti-replay revoke.
    await deps.db.$transaction(async (tx) => {
      await enterWriteRole(tx, 'auth_write')
      await tx.refreshToken.updateMany({ where: { familyId: row.familyId }, data: { revoked: true } })
    })
    throw new AuthzError('refresh-reuse-family-revoked')
  }
  const nowDate = new Date(now * 1000)
  if (nowDate > row.idleExpires) throw new AuthzError('refresh-idle-expired')
  if (nowDate > row.absoluteExpires) throw new AuthzError('refresh-absolute-expired')

  // Atomically claim this token (used=false -> true) and mint its successor. The
  // guarded update makes a concurrent double-rotate lose the race deterministically
  // (res.count === 0), which we then treat as replay.
  const token = newOpaqueToken()
  const claimed = await deps.db.$transaction(async (tx) => {
    // Spec 10d Task 6: enter auth_write FIRST, before any write in this tx.
    await enterWriteRole(tx, 'auth_write')
    const res = await tx.refreshToken.updateMany({
      where: { id: row.id, used: false, revoked: false },
      data: { used: true },
    })
    if (res.count === 0) return false
    await tx.refreshToken.create({
      data: {
        id: randomUUID(),
        tokenHash: hashToken(token),
        familyId: row.familyId,
        principalId: row.principalId,
        clientBind: row.clientBind,
        issuedAt: nowDate,
        idleExpires: new Date((now + deps.idleSec) * 1000),
        absoluteExpires: row.absoluteExpires,
      },
    })
    return true
  })
  if (!claimed) {
    // Race-loss revoke: the guarded update lost the race (a concurrent rotate
    // already claimed this token), treated as replay (6b). Same NAMED Fork-E
    // exception as the reuse-revoke above: own committing transaction, then
    // throw outside it, so the revoke runs under auth_write and still commits
    // before the throw.
    await deps.db.$transaction(async (tx) => {
      await enterWriteRole(tx, 'auth_write')
      await tx.refreshToken.updateMany({ where: { familyId: row.familyId }, data: { revoked: true } })
    })
    throw new AuthzError('refresh-reuse-family-revoked')
  }
  return { refreshToken: token, principalId: row.principalId, familyId: row.familyId }
}
