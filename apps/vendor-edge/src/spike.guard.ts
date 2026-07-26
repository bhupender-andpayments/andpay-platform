import { type CanActivate, type ExecutionContext, Injectable, Inject } from '@nestjs/common'
import { SPIKE_DEPS, type SpikeDeps } from './spike.deps.js'

// Spike-only: a guard that reads a header and uses a token-injected dep. This
// exercises the exact DI path the real EdgeCredentialGuard will use.
@Injectable()
export class SpikeGuard implements CanActivate {
  constructor(@Inject(SPIKE_DEPS) private readonly deps: SpikeDeps) {}

  canActivate(ctx: ExecutionContext): boolean {
    void this.deps
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>()
    const auth = req.headers['authorization']
    return typeof auth === 'string' && auth.startsWith('Bearer ok')
  }
}
