import { Module } from '@nestjs/common'
import { SpikeController } from './spike.controller.js'
import { SpikeGuard } from './spike.guard.js'
import { SPIKE_DEPS, type SpikeDeps } from './spike.deps.js'

const deps: SpikeDeps = { greeting: 'hello' }

// Spike-only: token-provided deps, no type-reflection DI.
@Module({
  controllers: [SpikeController],
  providers: [SpikeGuard, { provide: SPIKE_DEPS, useValue: deps }],
})
export class SpikeModule {}
