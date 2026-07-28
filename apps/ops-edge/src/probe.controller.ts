import { Controller, Get, Req, UseGuards } from '@nestjs/common'
import { OpsEdgeGuard } from './guard.js'
import type { EdgeRequest } from './request.js'

// A minimal guarded probe route (Part A only): it exists so the guard can be
// exercised over real HTTP before the Part-B ops controllers land. It returns
// ONLY non-sensitive claim enums (cls, mode) to prove the guard both passed
// AND attached the resolved claim to the request; it never echoes the token,
// the subject, or any scope value.
//
// Fix wave 1 (Task 9 review, Minor 3): `@UseGuards` moved to the CLASS level so
// this controller is authenticated by construction, like every other ops-edge
// controller, rather than relying on a per-method decorator a future route on
// this controller could forget.
@Controller('probe')
@UseGuards(OpsEdgeGuard)
export class ProbeController {
  @Get()
  probe(@Req() req: EdgeRequest): { ok: true; cls: number; mode: string } {
    return { ok: true, cls: req.claim.cls, mode: req.claim.mode }
  }
}
