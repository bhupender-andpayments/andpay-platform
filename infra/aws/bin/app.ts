#!/usr/bin/env node
import { App } from 'aws-cdk-lib'
import { EventBackboneStack } from '../lib/event-backbone-stack'

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

app.synth()
