import type { Admin } from 'kafkajs'
import type { TopicSpec } from './topics.js'

export interface ProvisionResult {
  created: string[]
  existing: string[]
}

/**
 * Create the given topics if they do not already exist. Idempotent: only missing
 * topics are created, so applying the same definitions twice creates nothing the
 * second time and never errors. This is a config-as-code apply run out of band
 * (CI/ops), never a runtime control-plane call (S23); producers publish only to
 * already-provisioned topics and never create them.
 */
export async function provisionTopics(
  admin: Admin,
  specs: TopicSpec[],
): Promise<ProvisionResult> {
  const existingTopics = await admin.listTopics()
  const toCreate = specs.filter((spec) => !existingTopics.includes(spec.name))

  if (toCreate.length > 0) {
    await admin.createTopics({
      waitForLeaders: true,
      topics: toCreate.map((spec) => ({
        topic: spec.name,
        numPartitions: spec.partitions,
        configEntries: spec.config
          ? Object.entries(spec.config).map(([name, value]) => ({ name, value }))
          : undefined,
      })),
    })
  }

  return {
    created: toCreate.map((spec) => spec.name),
    existing: specs.filter((spec) => existingTopics.includes(spec.name)).map((spec) => spec.name),
  }
}
