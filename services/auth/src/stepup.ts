// Step-up gate (6b) single-sourced in @andpay/authz (T2, DD2): the ops edge
// evaluates it locally without calling Auth (T4), so Auth re-imports the same
// primitive here instead of holding its own copy.
export { requireStepUp } from '@andpay/authz'
