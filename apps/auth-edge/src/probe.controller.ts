import { Controller, Get } from '@nestjs/common'

// A minimal unguarded health route. Unlike the ops/tenant probe (which sits
// behind the human-plane JWT guard because those edges are pure token
// CONSUMERS with no unauthenticated route at all), auth-edge is the token
// PRODUCER: login itself is necessarily unauthenticated, so this edge already
// has an unguarded surface by design. /probe carries no claim, no secret, and
// no domain data, just liveness.
@Controller('probe')
export class ProbeController {
  @Get()
  probe(): { status: 'ok' } {
    return { status: 'ok' }
  }
}
