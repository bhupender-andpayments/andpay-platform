import { expectTypeOf } from 'vitest'
import { newId, type UnitId, type BtchId, type VndrId, type ShptId } from '@andpay/ids'

// A UnitId is never assignable where a BtchId is expected (branded types).
expectTypeOf(newId('unit')).toEqualTypeOf<UnitId>()
expectTypeOf(newId('btch')).toEqualTypeOf<BtchId>()
expectTypeOf(newId('vndr')).toEqualTypeOf<VndrId>()
// @ts-expect-error a UnitId cannot be assigned to a BtchId
const wrong: BtchId = newId('unit')
void wrong

expectTypeOf(newId('shpt')).toEqualTypeOf<ShptId>()
// @ts-expect-error a UnitId cannot be assigned to a ShptId
const wrongShpt: ShptId = newId('unit')
void wrongShpt
