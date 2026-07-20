#!/usr/bin/env node
import { App } from 'aws-cdk-lib'
import { EventBackboneStack } from '../lib/event-backbone-stack'
import { AuthKeysStack } from '../lib/auth-keys-stack'

const app = new App()

// Primary: ap-south-1 (Mumbai). Payment data is resident in India (S6).
new EventBackboneStack(app, 'EventBackbonePrimary', {
  env: { region: 'ap-south-1' },
  isDr: false,
})

// DR: ap-south-2 (Hyderabad). A DR copy is storage, so DR stays in India (S6).
new EventBackboneStack(app, 'EventBackboneDr', {
  env: { region: 'ap-south-2' },
  isDr: true,
})

// Auth key material (spec 04): the D3 ES256 signing key as a multi-region KMS
// key (Decision 79) plus the 5c pepper in Secrets Manager. The primary lives in
// ap-south-1; the multi-region key and the replicated secret carry it to
// ap-south-2, so the same key id survives failover.
new AuthKeysStack(app, 'AuthKeysPrimary', {
  env: { region: 'ap-south-1' },
})

app.synth()
