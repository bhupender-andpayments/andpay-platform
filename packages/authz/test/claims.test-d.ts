import { expectTypeOf } from 'vitest'
import type { LeanClaim, Plane, Scope, PrincipalClass, Acr, Amr } from '../src/index.js'

// The D3 lean claim shape (16.3), locked at spec-04 planning.
expectTypeOf<LeanClaim['cls']>().toEqualTypeOf<PrincipalClass>()
expectTypeOf<PrincipalClass>().toEqualTypeOf<1 | 2 | 3 | 4 | 5 | 6>()
expectTypeOf<LeanClaim['aud']>().toEqualTypeOf<Plane>()
expectTypeOf<LeanClaim['mode']>().toEqualTypeOf<'live' | 'test'>()
expectTypeOf<LeanClaim['scope']>().toEqualTypeOf<Scope>()
expectTypeOf<LeanClaim['acr']>().toEqualTypeOf<Acr | undefined>()
expectTypeOf<LeanClaim['amr']>().toEqualTypeOf<Amr[] | undefined>()

// Scope is principal-specific: class 6 carries a vendor plus its work queue.
expectTypeOf<Scope>().toMatchTypeOf<{ vndr?: string; wq?: string }>()

// The standard envelope fields are all present and numeric where expected.
expectTypeOf<LeanClaim['iat']>().toEqualTypeOf<number>()
expectTypeOf<LeanClaim['auth_time']>().toEqualTypeOf<number | undefined>()
