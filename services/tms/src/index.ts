export { type TmsDb, PrismaClient } from './db.js'
export * from './events.js'
export * from './row-fact.js'
export * from './redact.js'
export { TMS_FACT_SCHEMAS } from './fact-schemas.js'
export {
  ingestRequestRow,
  ingestRequestRowWithinTx,
  requestRowRejectReason,
  // The soundbox duplicate-VPA gate (ruling 2026-08-10). Exported because both
  // TMS surfaces in ops.ts use them and the tests assert them directly; the
  // ops edge only ever sees the resulting DuplicateVpaOriginal on a result.
  seedKnownVpaOriginals,
  duplicateVpaVerdicts,
  type BankRequestRow,
  type RequestRowRejectReason,
  type DuplicateVpaOriginal,
} from './ingest.js'
export {
  parseBankRequestFile,
  DEFAULT_REQUEST_COLUMN_MAPPING,
  type BankColumnMapping,
  type StructuralParseError,
  type StructuralParseErrorCode,
  type BankRequestParseResult,
} from './bank-file-adapter.js'
export { projectMerchantFact, projectTenantFact } from './projections.js'
export {
  createAssignmentFromEnrollment,
  emitDemandFact,
  amendShipTo,
  activateAssignment,
  activateAssignmentWithinTx,
  type EnrollmentFactView,
} from './assignment.js'
export {
  ACTIVATION_STATUS_ORDER,
  ACTIVATION_STATUS_SOURCES,
  canAdvanceActivationStatus,
  recordActivationStatusWithinTx,
  readActivationTrail,
  type ActivationStatus,
  type ActivationStatusSource,
  type ActivationTrailEntry,
} from './activation-branch.js'
export {
  advanceCaseStatusWithinTx,
  projectDispatchToCases,
  projectShipmentToCases,
  normalizeCaseStatus,
  CASE_STATUS_VALUES,
  type CaseStatus,
  type DispatchFactView,
  type ShipmentFactView,
} from './damage-case.js'
export { flagDamageOps, type FlagDamageArgs, type FlagDamageResult } from './flag-damage.js'
export {
  UnwiredDevicePort,
  ManualDevicePort,
  type DevicePort,
  type ActivationCommand,
  type ActivationResult,
} from './device-port.js'
export { enterReadScope } from './read-context.js'
export { enterWriteScope, enterWriteRole } from './write-context.js'
export { readAssignments, readAssignmentById, type AssignmentReadRow } from './read.js'
export {
  previewBankFile,
  commitBankFile,
  resolveQuarantineRow,
  closeQuarantineRow,
  createDamageReasonOps,
  editDamageReasonOps,
  activateDamageReasonOps,
  deactivateDamageReasonOps,
  updateDamageCaseStatusOps,
  activateAssignmentOps,
  requestActivationOps,
  BankFileParseError,
  OpsClientError,
  type BankPreviewResult,
  type PreviewRowResult,
} from './ops.js'
export {
  readActivationTrailOps,
  type ActivationTrailOpsRow,
  readQuarantineQueue,
  listDamageReasons,
  readDamageCases,
  listMerchants,
  searchDispatchesByVpa,
  countDamageCasesByStatus,
  type QuarantineRowView,
  type QuarantineRowDetail,
  type DamageCaseView,
  type MerchantRow,
  type VpaDispatchRow,
  type DamageCaseSummary,
} from './ops-read.js'
export {
  createDamageReasonWithinTx,
  setDamageReasonActiveWithinTx,
  type DamageReasonRow,
} from './damage-reason.js'
