// Spike-only: an injected dependency bag, provided by an explicit token so DI
// never relies on emitDecoratorMetadata (esbuild drops it under vitest).
export interface SpikeDeps {
  greeting: string
}
export const SPIKE_DEPS = 'SPIKE_DEPS'
