// The D3 emergency denylist is a small async-replicated set of principal ids or
// jtis, checked cheaply on the hot path. Membership is the kill signal; the set
// itself is injected by the verifier process, never held by this library.
export function isDenylisted(idOrJti: string, set?: ReadonlySet<string>): boolean {
  return set?.has(idOrJti) ?? false
}
