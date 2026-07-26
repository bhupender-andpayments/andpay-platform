import { newEnvelope, type Envelope } from '@andpay/envelope'
import { stepKey } from '@andpay/keys'
import { enqueue, type OutboxTx } from '@andpay/outbox'

export const CREDENTIAL_CONFIG_TOPIC = 'cfg.auth.credential.v1'

// The auth-config channel (5c, check 1): the ONLY carrier of the class-6
// peppered hash and its scope, committed in the SAME transaction as the
// vendor_credential row write (E1). Consumed by the Fulfillment-side edge
// projection (task 5) so an apsk_ secret resolves locally, with zero call to
// Auth. The peppered hash is verification material, not a secret: it is
// useless without the 5c pepper (5c). IDs, enums, and the peppered hash ONLY,
// never a raw secret or PII (S7). This payload never appears on the public
// fct.auth.credential.v1 fact, which stays IDs-only.
export interface CredentialConfigPayload {
  apiId: string
  pepperedHash: string
  vndrId: string
  workQueue: string
  permissionSetRef: string
  mode: string
  status: string
  epoch: number
}

export function credentialConfigEnvelope(
  payload: CredentialConfigPayload,
  traceId: string,
): Envelope<CredentialConfigPayload> {
  return newEnvelope({
    type: CREDENTIAL_CONFIG_TOPIC,
    version: 1,
    subject: payload.apiId,
    dedupKey: stepKey(payload.apiId, payload.status.toLowerCase(), payload.epoch),
    traceId,
    payload,
  })
}

// Enqueue the cfg event INSIDE the caller's transaction (E1). It must commit
// atomically with the credential row write, so it takes the caller's tx and
// never opens its own. The topic is log-compacted, keyed by apiId
// (packages/bus/src/topics.ts): the latest value per apiId is the
// projection's current state.
export async function enqueueCredentialConfig(
  tx: OutboxTx,
  payload: CredentialConfigPayload,
  traceId: string,
): Promise<void> {
  const env = credentialConfigEnvelope(payload, traceId)
  await enqueue(tx, {
    aggregateType: 'auth_credential_config',
    aggregateId: payload.apiId,
    eventType: CREDENTIAL_CONFIG_TOPIC,
    partitionKey: payload.apiId,
    payload: env,
  })
}
