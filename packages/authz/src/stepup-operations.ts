// The step-up-gated ops operation identifiers, single-sourced here so both the
// server evaluator (stepup.ts OPS_STEP_UP_CATALOG) and any browser consumer (the
// ops portal) read one list with no drift (T2/DD2). This module imports NOTHING
// (no jose, no evaluator): it is safe to import into a browser bundle. The
// browser NEVER imports requireStepUp/meetsAcr (S24/T14): the client only needs
// to know WHICH actions are step-up-gated, never to evaluate freshness.
export const OPS_STEP_UP_GATED_OPERATIONS = ['terminal-override', 'hold-release', 'vendor-suspend'] as const

export type OpsStepUpKey = (typeof OPS_STEP_UP_GATED_OPERATIONS)[number]
