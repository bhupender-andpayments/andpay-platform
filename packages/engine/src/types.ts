/**
 * The D77 engine's isolated abstractions (O4): a flow is an ordered list of
 * steps, each with a forward action and an optional compensation. Business logic
 * lives in the step actions supplied by a flow definition, never in the engine.
 * The engine is client-agnostic: it runs raw SQL against the orchestrator schema
 * via any Prisma client (search-path-pinned), so a future Temporal swap is
 * mechanical.
 */

export interface EngineTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
}

export interface EngineClient extends EngineTx {
  $transaction<T>(fn: (tx: EngineTx) => Promise<T>): Promise<T>
}

/** Passed to a step's action and compensation. */
export interface StepContext {
  /** Native uuid of the saga instance (storage form). */
  instanceId: string
  /** The sg_ typed wire id of the saga instance. */
  sagaId: string
  /**
   * The step's own transaction. Command emission (via @andpay/outbox enqueue)
   * and timers set here commit atomically with the step's completion (E1).
   */
  tx: EngineTx
}

export interface Step {
  name: string
  action: (ctx: StepContext) => Promise<void>
  /** Forward reversing action (O3). Run in reverse order on flow failure. */
  compensate?: (ctx: StepContext) => Promise<void>
}

export interface FlowDefinition {
  type: string
  version: number
  steps: Step[]
}

export type InstanceStatus = 'running' | 'completed' | 'compensated' | 'failed'

export interface DueTimer {
  id: string
  instanceId: string
  purpose: string
}
