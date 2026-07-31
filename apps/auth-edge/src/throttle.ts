// The 6d source-token-bucket seam (spec 12 task 12). Defined here, in the
// scaffold task, so `AuthEdgeDeps` has its final shape before Tasks 9 to 11
// build the login/refresh/logout/enroll controllers against it: none of them
// need to reshape `AuthEdgeDeps` once the real bucket lands.
//
// `take` returns true when the caller may proceed and false when the source
// key (a per-IP or per-handle key, decided by Task 12) is over budget. It
// never throws; a throttled caller is a normal false, not an exception, so a
// controller decides the 429 mapping itself.
export interface ThrottlePort {
  take(sourceKey: string): Promise<boolean>
}

// The permissive default (Task 8 only): every take() succeeds, so nothing is
// throttled until Task 12 wires the real bucket. This is NOT the production
// default, it is the ONLY implementation that exists before Task 12; the real
// env builder and every test helper wire this until then.
export const NoThrottle: ThrottlePort = {
  async take(_sourceKey: string): Promise<boolean> {
    return true
  },
}
