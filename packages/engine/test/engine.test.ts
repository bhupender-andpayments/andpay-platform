import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaClient } from '../../../services/orchestrator/generated/client/index.js'
import { enqueue } from '@andpay/outbox'
import { SagaEngine, setTimer, claimAndFireDueTimers } from '../src/index.js'
import type { FlowDefinition } from '../src/index.js'

const DB_URL =
  process.env.ORCHESTRATOR_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=orchestrator'

const prisma = new PrismaClient({ datasourceUrl: DB_URL })
const engine = new SagaEngine(prisma)

beforeAll(() => prisma.$connect())
afterAll(() => prisma.$disconnect())
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE saga_instance, saga_step, saga_timer, outbox, inbox CASCADE',
  )
})

describe('@andpay/engine D77 orchestration engine', () => {
  // Acceptance 4: step + compensation
  it('runs two steps, fails the second, and compensates the first (O3)', async () => {
    let reserveRuns = 0
    let releaseRuns = 0
    const flow: FlowDefinition = {
      type: 'reference_pm',
      version: 1,
      steps: [
        {
          name: 'reserve',
          action: async (ctx) => {
            reserveRuns++
            // emit a command ONLY through the engine outbox (E1), atomic with the
            // step. This throwaway reference PM uses a TEST-ONLY topic so it never
            // references or pre-seeds the real Fulfillment command (cmd.fulfillment.*),
            // which arrives with its own schema at step 7.
            await enqueue(ctx.tx, {
              aggregateType: 'saga',
              aggregateId: ctx.sagaId,
              eventType: 'cmd.test.reference_pm.v1',
              partitionKey: ctx.sagaId,
              payload: { command: 'reserve_batch', sagaId: ctx.sagaId },
            })
          },
          compensate: async () => {
            releaseRuns++
          },
        },
        {
          name: 'confirm',
          action: async () => {
            throw new Error('confirm failed on purpose')
          },
        },
      ],
    }

    const { instanceId } = await engine.start(flow)
    const before = await prisma.sagaInstance.findUnique({ where: { id: instanceId } })
    expect(before?.status).toBe('running')

    const result = await engine.runFlow(instanceId, flow)
    expect(result).toBe('compensated')

    const after = await prisma.sagaInstance.findUnique({ where: { id: instanceId } })
    expect(after?.status).toBe('compensated')

    const steps = await prisma.sagaStep.findMany({ where: { instanceId } })
    expect(steps.find((s) => s.name === 'reserve')?.status).toBe('compensated')
    expect(steps.find((s) => s.name === 'confirm')?.status).toBe('failed')
    expect(steps.find((s) => s.name === 'confirm')?.lastErrorClass).toBe('Error')

    expect(reserveRuns).toBe(1)
    expect(releaseRuns).toBe(1)

    // the command the reserve step emitted is durably in the engine outbox (E1),
    // committed with the step; compensation is a forward action, not a rollback.
    expect(await prisma.outbox.count()).toBe(1)
  })

  // Acceptance 4: idempotent step under fact re-delivery
  it('treats a re-delivered advancing fact as a no-op (idempotent step)', async () => {
    let runs = 0
    const step = {
      name: 'once',
      action: async () => {
        runs++
        return Promise.resolve()
      },
    }
    const { instanceId } = await engine.start({ type: 'idem', version: 1, steps: [step] })

    await engine.runStep(instanceId, step)
    await engine.runStep(instanceId, step) // re-delivery of the same fact

    expect(runs).toBe(1)
    const row = await prisma.sagaStep.findFirst({ where: { instanceId, name: 'once' } })
    expect(row?.status).toBe('completed')
    expect(row?.attempts).toBe(1)
  })

  // Acceptance 5: durable timer, concurrent workers
  it('fires due timers exactly once under two concurrent workers (no double-fire, no skip)', async () => {
    const { instanceId } = await engine.start({ type: 'timers', version: 1, steps: [] })
    const N = 20
    const past = new Date(Date.now() - 60_000)
    for (let i = 0; i < N; i++) {
      await prisma.$transaction((tx) => setTimer(tx, instanceId, past, `purpose_${String(i)}`))
    }

    const now = new Date()
    const collect = (into: string[]) => async (timer: { id: string }) => {
      await new Promise((r) => setTimeout(r, 20)) // hold the tx open so workers overlap
      into.push(timer.id)
    }
    const workerA: string[] = []
    const workerB: string[] = []
    // batchSize N/2 caps each worker, so the N due timers split deterministically
    // across the two workers via SKIP LOCKED; both do work.
    const [firedA, firedB] = await Promise.all([
      claimAndFireDueTimers(prisma, now, collect(workerA), N / 2),
      claimAndFireDueTimers(prisma, now, collect(workerB), N / 2),
    ])

    expect(firedA).toHaveLength(N / 2) // worker A did half
    expect(firedB).toHaveLength(N / 2) // worker B did half
    const overlap = firedA.filter((id) => firedB.includes(id))
    expect(overlap).toHaveLength(0) // no double-fire
    expect(new Set([...firedA, ...firedB]).size).toBe(N) // no skip

    expect(await prisma.sagaTimer.count({ where: { instanceId, status: 'pending' } })).toBe(0)
    expect(await prisma.sagaTimer.count({ where: { instanceId, status: 'fired' } })).toBe(N)
  })
})
