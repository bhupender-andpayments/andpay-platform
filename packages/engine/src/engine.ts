import { newId, toUuid, fromUuid } from '@andpay/ids'
import { stepKey } from '@andpay/keys'
import type {
  EngineClient,
  FlowDefinition,
  InstanceStatus,
  Step,
  StepContext,
} from './types.js'

function errorClass(err: unknown): string {
  // A class name only, never the message (S7: IDs and enums, no PII).
  return err instanceof Error ? err.constructor.name : 'UnknownError'
}

/**
 * The saga / process-manager engine. Runs a flow's steps in order; on a step
 * failure it compensates the completed steps in reverse with their forward
 * reversing actions (O3). Steps are idempotent on their 06.A step key: a step
 * already completed is a no-op when re-driven by a re-delivered fact.
 */
export class SagaEngine {
  constructor(private readonly client: EngineClient) {}

  /** Create a new instance (sg_ id stored as a native uuid, I3). */
  async start(flow: FlowDefinition): Promise<{ instanceId: string; sagaId: string }> {
    const sagaId = newId('sg')
    const instanceId = toUuid(sagaId)
    await this.client.$executeRaw`
      INSERT INTO saga_instance (id, flow_type, flow_version, status, updated_at)
      VALUES (${instanceId}::uuid, ${flow.type}, ${flow.version}, 'running', now())
    `
    return { instanceId, sagaId }
  }

  /**
   * Run a single step, at most once effectively. If the step is already
   * completed, this is a no-op (idempotent under fact re-delivery). Otherwise the
   * action runs and the step is marked completed in ONE transaction, so any
   * command the action emits via the engine outbox commits with the completion
   * (E1). If the action throws, that transaction rolls back and the failure is
   * recorded durably in a separate transaction.
   */
  async runStep(instanceId: string, step: Step): Promise<void> {
    const existing = await this.client.$queryRaw<{ status: string }[]>`
      SELECT status FROM saga_step WHERE instance_id = ${instanceId}::uuid AND name = ${step.name}
    `
    if (existing[0]?.status === 'completed') return

    const idempotencyKey = stepKey(instanceId, step.name)
    await this.client.$executeRaw`
      INSERT INTO saga_step (instance_id, name, status, attempts, idempotency_key, updated_at)
      VALUES (${instanceId}::uuid, ${step.name}, 'running', 1, ${idempotencyKey}, now())
      ON CONFLICT (instance_id, name)
      DO UPDATE SET status = 'running', attempts = saga_step.attempts + 1, updated_at = now()
    `

    try {
      await this.client.$transaction(async (tx) => {
        const ctx: StepContext = { instanceId, sagaId: fromUuid('sg', instanceId), tx }
        await step.action(ctx)
        await tx.$executeRaw`
          UPDATE saga_step SET status = 'completed', updated_at = now()
          WHERE instance_id = ${instanceId}::uuid AND name = ${step.name}
        `
        await tx.$executeRaw`
          UPDATE saga_instance SET current_step = ${step.name}, updated_at = now()
          WHERE id = ${instanceId}::uuid
        `
      })
    } catch (err) {
      await this.client.$executeRaw`
        UPDATE saga_step SET status = 'failed', last_error_class = ${errorClass(err)}, updated_at = now()
        WHERE instance_id = ${instanceId}::uuid AND name = ${step.name}
      `
      throw err
    }
  }

  /**
   * Run the flow to completion, or compensate on failure. Returns the terminal
   * instance status. Compensation runs completed steps' reversing actions in
   * reverse order (O3), each in its own transaction.
   */
  async runFlow(instanceId: string, flow: FlowDefinition): Promise<InstanceStatus> {
    const completed: Step[] = []
    try {
      for (const step of flow.steps) {
        await this.runStep(instanceId, step)
        completed.push(step)
      }
      await this.client.$executeRaw`
        UPDATE saga_instance SET status = 'completed', updated_at = now() WHERE id = ${instanceId}::uuid
      `
      return 'completed'
    } catch {
      for (const step of [...completed].reverse()) {
        if (!step.compensate) continue
        const compensate = step.compensate
        await this.client.$transaction(async (tx) => {
          await compensate({ instanceId, sagaId: fromUuid('sg', instanceId), tx })
          await tx.$executeRaw`
            UPDATE saga_step SET status = 'compensated', updated_at = now()
            WHERE instance_id = ${instanceId}::uuid AND name = ${step.name}
          `
        })
      }
      await this.client.$executeRaw`
        UPDATE saga_instance SET status = 'compensated', updated_at = now() WHERE id = ${instanceId}::uuid
      `
      return 'compensated'
    }
  }
}
