import { newEnvelope, type Envelope } from '@andpay/envelope'

export const AUTH_CREDENTIAL_TOPIC = 'fct.auth.credential.v1'

// The IDs-only lifecycle payload (S7): the loggable api_ id, the referenced
// vndr_ id, the status, epoch, and mode. NEVER the secret (5c). Downstream
// (vendor portal, Fulfillment) reacts to this; partition key is the api_ id.
export interface CredentialFactPayload {
  apiId: string
  vndrRef: string
  status: string
  epoch: number
  mode: string
}

export function credentialFactEnvelope(input: {
  payload: CredentialFactPayload
  dedupKey: string
  traceId: string
}): Envelope<CredentialFactPayload> {
  return newEnvelope({
    type: AUTH_CREDENTIAL_TOPIC,
    version: 1,
    subject: input.payload.apiId,
    dedupKey: input.dedupKey,
    traceId: input.traceId,
    payload: input.payload,
  })
}
