import { Controller, Post, Body, UseGuards, Inject, UseInterceptors, UploadedFile } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { SpikeGuard } from './spike.guard.js'
import { SPIKE_DEPS, type SpikeDeps } from './spike.deps.js'

interface UploadedJson {
  buffer: Buffer
  originalname: string
}

// Spike-only: proves a JSON-body route and a multipart-file route both work
// under a guard, with token-injected deps.
@Controller('spike')
export class SpikeController {
  constructor(@Inject(SPIKE_DEPS) private readonly deps: SpikeDeps) {}

  @Post('echo')
  @UseGuards(SpikeGuard)
  echo(@Body() body: { name?: string }): { greeting: string; name: string } {
    return { greeting: this.deps.greeting, name: body.name ?? 'anon' }
  }

  @Post('upload')
  @UseGuards(SpikeGuard)
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: UploadedJson): { parsed: unknown } {
    const parsed: unknown = JSON.parse(file.buffer.toString('utf8'))
    return { parsed }
  }
}
