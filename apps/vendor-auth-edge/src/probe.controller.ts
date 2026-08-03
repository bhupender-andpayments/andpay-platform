import { Controller, Get } from '@nestjs/common'

// A minimal unguarded health route. Like apps/auth-edge, vendor-auth-edge is
// a token PRODUCER: login itself is necessarily unauthenticated, so this edge
// already has an unguarded surface by design. /probe carries no claim, no
// secret, and no domain data, just liveness.
@Controller('probe')
export class ProbeController {
  @Get()
  probe(): { status: 'ok' } {
    return { status: 'ok' }
  }
}
