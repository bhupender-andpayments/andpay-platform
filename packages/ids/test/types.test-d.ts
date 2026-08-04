import { expectTypeOf } from 'vitest'
import { newId } from '../src/index.js'
import type { AsgnId, UnitId, TnntId, ProgId, SmrchId } from '../src/index.js'

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

// Sub-merchant prefix: SmrchId is a distinct branded kind (mrch -> smrch -> asgn model).
const smrch = newId('smrch')

expectTypeOf(smrch).toEqualTypeOf<SmrchId>()
expectTypeOf<SmrchId>().not.toEqualTypeOf<AsgnId>()

// @ts-expect-error a SmrchId is not assignable to an AsgnId
const bad3: AsgnId = smrch
void bad3
