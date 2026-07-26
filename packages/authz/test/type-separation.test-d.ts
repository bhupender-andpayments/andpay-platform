import { humanRole } from '../src/index.js'

// Positive: open human strings are accepted (no closed human set).
humanRole({ permissions: ['vendor_credential:create', 'mfa:reset', '*'], ceiling: 'own-program', requiredAcr: 'AAL2' })

// @ts-expect-error a class-6 permission is UNREPRESENTABLE in a human role.
humanRole({ permissions: ['shipment:submit-status'], ceiling: 'all-programs', requiredAcr: 'AAL3' })

// @ts-expect-error every class-6 literal is rejected (batch:pull-artifacts too).
humanRole({ permissions: ['batch:pull-artifacts'], ceiling: 'own-program', requiredAcr: 'AAL2' })

// @ts-expect-error a class-6 literal mixed with open human strings is still rejected.
humanRole({ permissions: ['vendor_credential:create', 'sheet:submit-intake'], ceiling: 'own-program', requiredAcr: 'AAL2' })
