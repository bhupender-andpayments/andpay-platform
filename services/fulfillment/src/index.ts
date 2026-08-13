export { type FulfillmentDb, PrismaClient } from './db.js'
export * from './events.js'
export { FULFILLMENT_FACT_SCHEMAS } from './fact-schemas.js'
export * from './redact.js'
export { loadFulfillmentConfig } from './authz-config.js'
export { type Tx, CONSUMER, setProgramContext } from './internal.js'
export {
  type CreateVendorInput,
  type UpdateVendorInput,
  type OpsActor,
  createVendor,
  createVendorWithinTx,
  updateVendorWithinTx,
  isCourierBatchMode,
} from './vendor.js'
export {
  parseReturnWorkbook,
  type ReturnSheetParseResult,
  type ReturnSheetRowError,
  type ReturnSheetRowErrorCode,
  type ReturnSheetStructuralError,
} from './return-sheet-adapter.js'
export { projectDemandFact } from './pool.js'
export {
  UNIT_STATUS_ORDER,
  UNIT_TERMINAL_STATUSES,
  canAdvanceUnitStatus,
  advanceUnitStatus,
  advanceUnitsForShipment,
  advanceUnitsForAssignment,
  markUnitsActivatedForAssignment,
  type UnitStatus,
  type UnitTerminalStatus,
  type AnyUnitStatus,
  projectActivationToUnits,
  projectReplacementToUnits,
  type ActivatedFactView,
  type ReplacementRaisedFactView,
} from './unit-lifecycle.js'
export { projectShipToAmended, NotYet } from './ship-to.js'
export { poolConfig, resolvePoolConfig, DEFAULT_POOL_CFG, type PoolCfg } from './config/pool-config.js'
export {
  ensurePool,
  triggerBatch,
  triggerBatchWithinTx,
  onDemandAccrued,
  runDueBatchTimers,
  manualTrigger,
  holdEntry,
  holdEntryWithinTx,
  type PoolAnchor,
  type TriggerBatchOpts,
} from './batching.js'
export {
  type SerializedIntakeRow,
  type QuantityLineIntakeRow,
  type IntakeRow,
  type IntakeSheet,
  type IntakeResult,
  ingestIntakeSheet,
  ingestIntakeSheetWithinTx,
  isSheetStructurallyValid,
} from './intake.js'
export { consumeBatchFact, TemplateTrimMismatchError } from './dispatch.js'
export {
  type AdapterFunction,
  type PackageLine,
  type ArtifactRef,
  type CollateralGroup,
  type PrintLayout,
  buildDispatchPackage,
  dispatchGroupXlsx,
  buildDispatchGroupXlsx,
  readBatchPrintLayout,
  excelLinesFor,
  resolveCollateralGroup,
  assembleGroupPdf,
  AssetResolutionError,
} from './package.js'
export {
  type ReturnRow,
  type ReturnSheet,
  type ReturnResult,
  ingestReturnSheet,
} from './return-sheet.js'
export {
  advanceShipmentStatus,
  isKnownStatus,
  LADDER_RANK,
  TERMINAL,
  type StatusUpdate,
  type StatusSource,
  type AdvanceOutcome,
} from './courier-status.js'
export {
  ingestStatusFile,
  type StatusFile,
  type StatusRow,
  type StatusFileResult,
} from './status-file.js'
export { ingestOpsCourierStatus, type OpsCourierStatusResult } from './ops-courier-status.js'
export {
  parseCourierStatusFile,
  type CourierStatusFileRow,
  type CourierStatusRowError,
  type CourierStatusRowErrorCode,
  type CourierStatusStructuralError,
  type CourierStatusStructuralErrorCode,
  type CourierStatusParseResult,
} from './courier-status-adapter.js'
export { parseSheetGrid, headerIndexer, type SheetGrid, type SheetGridError } from './sheet-grid.js'
export {
  parseActivationFile,
  type ActivationFileRow,
  type ActivationFileRowError,
  type ActivationFileRowErrorCode,
  type ActivationFileStructuralError,
  type ActivationFileStructuralErrorCode,
  type ActivationFileParseResult,
} from './activation-file-adapter.js'
export {
  ingestStatusWebhook,
  passthroughMapper,
  type WebhookEvent,
  type WebhookResult,
  type CourierPayloadMapper,
} from './status-webhook.js'
export {
  type CredentialConfigPayload,
  CREDENTIAL_CONFIG_CONSUMER,
  projectCredentialConfig,
  credentialLookup,
  loadCredentialProjection,
} from './credential-projection.js'
export { type CredentialProjectionRow } from '@andpay/authz'
export { emitVendorAuthzAudit } from './vendor-audit.js'
export { enterReadScope } from './read-context.js'
export { enterWriteScope, enterWriteRole } from './write-context.js'
export { enterVendorReadScope } from './vendor-read-context.js'
export { type WorkQueueRow, readVendorWorkQueue, type HistoryRow, readVendorHistory } from './vendor-reads.js'
export { type PullXlsxResult, type PullPdfResult, pullDispatchPackageXlsx, pullTypePdf, PullDeniedError } from './vendor-pull.js'
export {
  correctStatus,
  overrideTerminal,
  recomposeArtifact,
  holdRecord,
  releaseRecord,
  manualBatch,
  suspendVendor,
  createVendorOps,
  editVendorOps,
  resolveIntakeException,
  resolveStatusException,
  OpsClientError,
  upsertBankCompositionConfig,
  type UpsertBankCompositionConfigInput,
  setBankLogo,
  type SetBankLogoInput,
  setBankTemplateMaster,
  type SetBankTemplateMasterInput,
  upsertBatchingConfig,
  type UpsertBatchingConfigInput,
  setVendorPrintLayout,
  type SetVendorPrintLayoutInput,
} from './ops.js'
export { OPS_ROLES, loadOpsConfig } from './ops-config.js'
export {
  type DeviceInventoryStructuralErrorCode,
  type DeviceInventoryStructuralError,
  type DeviceInventoryRow,
  type DeviceInventoryRowErrorCode,
  type DeviceInventoryRowError,
  type DeviceInventoryParseResult,
  parseDeviceInventoryFile,
} from './device-inventory-adapter.js'
export { type OpsDeviceInventoryResult, ingestOpsDeviceInventory } from './ops-device-inventory.js'
export {
  listVendors,
  type VendorRow,
  readIntakeExceptions,
  readCourierStatusExceptions,
  type IntakeExceptionView,
  type CourierStatusExceptionView,
  listBankCompositionConfigs,
  type BankCompositionConfigRow,
  listBatchingConfigs,
  type BatchingConfigRow,
  // P2-1: the object-spine reads (batch list, batch detail, pool, dispatches).
  listBatches,
  type BatchRow,
  readBatchDetail,
  type BatchDetailView,
  type BatchEntryRow,
  type BatchArtifactRow,
  listPoolEntries,
  type PoolEntryRow,
  listDispatches,
  listDeviceInventory,
  readShipmentTrailOps,
  resolveAssignmentsByDeviceSerial,
  type DispatchStatusEventRow,
  type DispatchRow,
  type UnitInventoryRow,
} from './ops-read.js'
export type { AssetStore, AssetMeta, StoredAsset, PutResult, AssetRecord } from './storage/asset-store.js'
export { InMemoryAssetStore } from './storage/dev-asset-store.js'
export { FilesystemAssetStore, defaultAssetDir } from './storage/fs-asset-store.js'
export {
  readShipments,
  readShipmentStatusTrail,
  type ShipmentReadRow,
  type ShipmentStatusEventRow,
} from './read.js'
