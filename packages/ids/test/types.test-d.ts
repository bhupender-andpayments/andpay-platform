import { expectTypeOf } from 'vitest'
import { newId } from '../src/index.js'
import type { AsgnId, UnitId } from '../src/index.js'

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
