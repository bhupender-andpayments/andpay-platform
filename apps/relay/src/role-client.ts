/**
 * The `SET LOCAL ROLE` wrapper every relay drain runs under.
 *
 * `relayOnce` (@andpay/outbox) opens its OWN transaction and does the claim,
 * publish and stamp inside it. It has no idea about roles, so the only place a
 * role can be applied is by wrapping the client's `$transaction` and issuing
 * `SET LOCAL ROLE` as the first statement inside it. LOCAL is what makes this
 * correct: the role reverts when the transaction ends, so a pooled connection
 * is never handed back still wearing an infra role.
 *
 * This is the production form of the harness wrapper proven in
 * `test/write_plane_c4.test.ts` (proof 1), which is the existing evidence that
 * `relayOnce` really does drain under `<ctx>_relay` and not as the owner. That
 * proof matters more than usual right now: the only DB login role today is
 * SUPERUSER + BYPASSRLS (GO_LIVE_BLOCKERS, task E-3), so a MISSING role
 * assignment would look identical to a working one until the day that login
 * role is fixed. Running under the role from the start means the relay does not
 * silently acquire a dependency on being superuser.
 */
export interface RelayTx {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

export interface TransactionalClient {
  $transaction<T>(fn: (tx: RelayTx) => Promise<T>): Promise<T>
}

/**
 * Wraps `client` so every transaction it opens begins with `SET LOCAL ROLE
 * <role>`.
 *
 * `role` is interpolated, not parameterised, because Postgres does not accept a
 * bind parameter for a role name. Callers pass only the compile-time constants
 * in `contexts.ts`, and `assertRelayContextsAreSafe` checks their shape at
 * startup.
 */
export function withRole<C extends TransactionalClient>(client: C, role: string): C {
  const base = client as TransactionalClient
  return {
    $transaction: <T>(fn: (tx: RelayTx) => Promise<T>): Promise<T> =>
      base.$transaction(async (tx: RelayTx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
        return fn(tx)
      }),
  } as unknown as C
}
