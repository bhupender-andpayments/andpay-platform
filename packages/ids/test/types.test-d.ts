import { expectTypeOf } from 'vitest'
import { newId } from '../src/index.js'
import type { AsgnId, UnitId, TnntId, ProgId } from '../src/index.js'

// Check 6: branded types are distinct per kind.
const asgn = newId('asgn')
const unit = newId('unit')

expectTypeOf(asgn).toEqualTypeOf<AsgnId>()
expectTypeOf(unit).toEqualTypeOf<UnitId>()
expectTypeOf<AsgnId>().not.toEqualTypeOf<UnitId>()

// Cross-kind assignment must fail compilation.
// @ts-expect-error an AsgnId is not assignable to a UnitId
const bad: UnitId = asgn
void bad

// Spec 05 identity prefixes: tnnt_ and prog_ are distinct branded kinds.
const tnnt = newId('tnnt')
const prog = newId('prog')

expectTypeOf(tnnt).toEqualTypeOf<TnntId>()
expectTypeOf(prog).toEqualTypeOf<ProgId>()
expectTypeOf<TnntId>().not.toEqualTypeOf<ProgId>()

// @ts-expect-error a TnntId is not assignable to a ProgId
const bad2: ProgId = tnnt
void bad2
