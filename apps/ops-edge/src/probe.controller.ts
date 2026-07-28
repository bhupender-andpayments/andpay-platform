import { Controller, Get, Req, UseGuards } from '@nestjs/common'
import { OpsEdgeGuard } from './guard.js'
import type { EdgeRequest } from './request.js'

// A minimal guarded probe route (Part A only): it exists so the guard can be
// exercised over real HTTP before the Part-B ops controllers land. It returns
// ONLY non-sensitive claim enums (cls, mode) to prove the guard both passed
// AND attached the resolved claim to the request; it never echoes the token,
// the subject, or any scope value.
@Controller('probe')
export class ProbeController {
  @Get()
  @UseGuards(OpsEdgeGuard)
  probe(@Req() req: EdgeRequest): { ok: true; cls: number; mode: string } {
    return { ok: true, cls: req.claim.cls, mode: req.claim.mode }
  }
}
