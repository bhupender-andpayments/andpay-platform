import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { createHash } from 'node:crypto'
import { authorize, requireStepUp, OPS_STEP_UP_CATALOG } from '@andpay/authz'
import {
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
  isKnownStatus,
  upsertBankCompositionConfig,
  setBankLogo,
  setBankTemplateMaster,
  upsertBatchingConfig,
  setVendorPrintLayout,
  ingestOpsDeviceInventory,
  ingestOpsCourierStatus,
  parseActivationFile,
  resolveAssignmentsByDeviceSerial,
  previewOpsDeviceInventory,
  correctUnitStatus,
  previewOpsUnitStatus,
  ingestOpsUnitStatus,
  parseReturnWorkbook,
  ingestReturnSheetOps,
  UNIT_STATUS_ORDER,
  UNIT_TERMINAL_STATUSES,
  type ActivationFileRowError,
  type IntakeSheet,
  type OpsDeviceInventoryResult,
  type OpsDeviceInventoryPreview,
  type OpsCourierStatusResult,
  type OpsUnitStatusPreview,
  type OpsUnitStatusResult,
  type OpsReturnResult,
  type ReturnSheetParseResult,
} from '@andpay/fulfillment-service'
import {
  previewBankFile,
  commitBankFile,
  flagDamageOps,
  resolveQuarantineRow,
  closeQuarantineRow,
  createDamageReasonOps,
  activateDamageReasonOps,
  deactivateDamageReasonOps,
  updateDamageCaseStatusOps,
  activateAssignmentOps,
  requestActivationOps,
  ManualDevicePort,
  type BankRequestRow,
  type BankPreviewResult,
  type FlagDamageResult,
  type DamageReasonRow,
  type DuplicateVpaOriginal,
} from '@andpay/tms-service'
import { readDispatchActivationStatus } from '@andpay/analytics-service'
import { createBankMaster, createMerchant, editBankMaster } from '@andpay/identity-service'
import { OpsEdgeGuard } from './guard.js'
import { EDGE_DEPS, MAX_UPLOAD_BYTES, type OpsEdgeDeps } from './deps.js'
import { emitOpsAuthzAudit } from './audit.js'
import type { EdgeRequest } from './request.js'

// A local wall-clock read in whole seconds, for the step-up freshness check
// (auth_time is a second-resolution claim). Date.now() is permitted in app
// runtime code (only workflow scripts forbid a live clock); the value is
// compared, never persisted, so it introduces no non-determinism into any fact.
function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

// The mutation request bodies carry TARGET params ONLY (D99, M7/S16): the actor
// (`sub`) and any scope come from the verified claim the guard attached, never
// from these. A spoofed actor/program/tenant field here is simply never read.
interface CorrectBody {
  status: string
  courierTimestamp: string
}
// The manual unit-status correction body (2026-08-13 ruling): a target status
// only. Unlike CorrectBody there is no courierTimestamp - a unit has no
// separate event-time column, only status + updated_at.
interface UnitStatusBody {
  status: string
}
const KNOWN_UNIT_STATUSES: readonly string[] = [...UNIT_STATUS_ORDER, ...UNIT_TERMINAL_STATUSES]
interface OverrideBody {
  status: string
  courierTimestamp: string
  overrideReason: string
}
interface RecomposeBody {
  asgnId: string
  artifactType: string
  requestedShipTo?: string
}
interface DamageCaseStatusBody {
  status: string
  // Workflow C step 1 (T6.4): the operator's own note on the case, distinct
  // from the bank's remarks on the damage row. Optional, and omitting it leaves
  // any existing note alone; free text, so it lands on the domain row and never
  // on the IDs-only 6e, the same posture as HoldBody.reason.
  opsRemarks?: string
}
// D-26/D-27 (DAMAGE_PLAN B5): the Flag Damage body. The target dispatch leg is
// the :asgnId route param; reasonCode is a damage_reason master CODE (DP-5,
// validated active by the domain), remarks is the operator's required free-text
// why (it lands on the domain row, never the IDs-only 6e, same posture as
// HoldBody.reason), and the two counts apply to a COLLATERAL leg only (DP-2;
// the domain rejects any count on a SOUNDBOX leg, whose quantity is fixed at
// 1). The actor comes from the verified claim, never here (D99, M7/S16).
interface FlagDamageBody {
  reasonCode: string
  remarks: string
  standeeCount?: number
  stickerCount?: number
}
// The cap on the flag-damage remarks, kept identical to the domain contract's
// own max (flagDamageOps: trimmed non-empty, max 500). Two checks, one number,
// same split as MAX_TRIGGER_REASON_LENGTH below: the edge check produces the
// operator-facing 400 message, the domain check is the guarantee.
const MAX_FLAG_REMARKS_LENGTH = 500
// Phase 5 Task 2 (D-H.1): the target rides in the BODY, not a route param
// (unlike hold/release/damage-case-status), because this is the FIRST caller
// of the TMS activation path (grounding section 2) and there is no existing
// `:asgnId`-scoped route shape to preserve here; dispatchId is the asgn_ wire
// id (the BRD Dispatch ID), decoded server-side by TMS, never here (D99).
interface ActivateAssignmentBody {
  dispatchId: string
}
// D-16 (T4.1b): the other half of the activation branch. A LIST, because an
// operator exports a worklist and sends it to the CWD in one go; stamping thirty
// rows through thirty requests would leave a half-sent batch on any failure.
interface RequestActivationBody {
  dispatchIds: string[]
}
// D-19 (T5.4): the bulk mark-activated body. A list for the same reason the
// CWD-request body is one, and the response is PER ROW rather than a single
// verdict, which is the whole point (see the route).
interface BulkActivateBody {
  dispatchIds: string[]
}
// One row's outcome from an activation attempt, shared by the bulk route and the
// activation file upload. `reason` is null exactly when `activated` is true.
interface ActivationRowResult {
  dispatchId: string
  activated: boolean
  reason: string | null
}
// 12 Aug 2026: a manual hold carries its reason, like the manual trigger below.
// Free text, so it lands on the domain row (pending_pool_entry.hold_reason) and
// never on the IDs-only 6e, the same posture as OverrideBody.overrideReason and
// BatchTriggerBody.reason.
interface HoldBody {
  reason: string
}
interface BatchTriggerBody {
  tenantWire: string
  programWire: string
  // BRD 5.3.4 force dispatch: REQUIRED. The trigger already recorded who fired
  // it (batch.triggered_by_actor); this is why. Free text, so it lands on the
  // domain row (batch.trigger_note) and never on the IDs-only 6e (DD1), the
  // same posture as OverrideBody.overrideReason above.
  reason: string
}
// The cap on that reason, kept identical to the domain's own
// MAX_TRIGGER_NOTE_LENGTH in services/fulfillment/src/ops.ts. Two checks, one
// number: the edge check produces the operator-facing 400 message, the domain
// check is the guarantee that holds for every caller.
const MAX_TRIGGER_REASON_LENGTH = 500
interface VendorCreateBody {
  type: string
  displayName: string
  // Phase 3 Task 2 (BRD FR-11): both optional, COURIER-applicable only.
  courierCode?: string
  integrationMode?: string
}
// Phase 3 Task 2 (BRD FR-11): the courier master edit body. Every field is
// optional (a partial edit); the target vndr is the route param, never here.
interface VendorEditBody {
  displayName?: string
  courierCode?: string
  integrationMode?: string
}
interface DamageReasonCreateBody {
  code: string
  label: string
}
// Phase 3 Task 5b (BRD Annexure D.4): the bank/branch composition-config
// upsert body. bankCode/branchCode/tenantWire ARE legitimate request inputs
// here (platform master data an AndPayments admin configures, not
// principal-scoped tenant data, unlike M7/S16's merchant/vendor/mode rule);
// the actor/traceId/idempotency-key still come from the gate, never here.
// branchCode is optional (the '' bank-level-default sentinel, T5a).
interface BankConfigUpsertBody {
  tenantWire: string
  bankCode: string
  branchCode?: string
  brandingParams: unknown
  imageTemplates: unknown
}
// Phase 3 Task 6 (BRD 5.3.2): the batching-parameter admin write body. The
// scope-key fields (tenantWire/programWire) ARE legitimate request inputs
// (platform master data an AndPayments admin configures, not principal-scoped
// tenant data, unlike M7/S16); both optional (omitted -> GLOBAL default). The
// actor/traceId/idempotency-key still come from the gate, never here.
interface BatchingConfigSetBody {
  tenantWire?: string
  programWire?: string
  // R-7 (16 Aug 2026): the per-bank MIN LOT override tier. When set, the
  // domain write requires tenantWire and refuses maxWaitSeconds (a bank tier
  // carries min lot only; max wait stays on the pool tiers, where the timer
  // that reads it is armed).
  bankReferenceCode?: string
  minLotSize: number
  maxWaitSeconds?: number
}
// Task 12 (W-6): the PRINT vendor print_layout admin write body. The target
// vndr is the route param, never here; layout is the only field and is
// validated against the closed enum in the domain function (OpsClientError
// on anything else).
interface VendorPrintLayoutSetBody {
  layout: string
}
// Phase 3 Task 7 (BRD Annexure D): the Bank Master create body. bankReferenceCode
// (the immutable ingest resolver key) is set ONCE here at create time and is a
// legitimate request input (platform master data an AndPayments admin
// configures, not principal-scoped tenant data, unlike M7/S16); the actor/
// traceId/idempotency-key still come from the gate, never the body. address2/
// address3 are the only optional fields (BRD D.1).
// The ops Add-merchant body (BRD 5.1, the bank-file field table). `tnntWire` is
// the Bank Master the merchant is sponsored by, picked from master data: it is
// half of the (tenant, bank_merchant_reference) resolver key, so it is what
// makes the later bank file resolve to this merchant instead of minting a
// second one. Absent, deliberately: bank branch, QR string and the kit
// quantities, which belong to a REQUEST and arrive on the bank request file.
interface MerchantCreateBody {
  tnntWire: string
  displayName: string
  legalName: string
  mcc: string
  vpa: string
  contactName: string
  mobile: string
  email?: string
  address: string
  address2?: string
  address3?: string
  city: string
  state: string
  pincode: string
}

interface BankMasterCreateBody {
  bankReferenceCode: string
  displayName: string
  address1: string
  address2?: string
  address3?: string
  city: string
  district: string
  country: string
  pin: string
  mobile: string
  email: string
}
// The Bank Master edit body. bankReferenceCode is DELIBERATELY ABSENT: it is
// the immutable ingest resolver key and can neither be accepted nor mutated by
// the edit path. Every content field is optional (a partial edit); the target
// tnnt is the route param, never here.
interface BankMasterEditBody {
  displayName?: string
  address1?: string
  address2?: string
  address3?: string
  city?: string
  district?: string
  country?: string
  pin?: string
  mobile?: string
  email?: string
  status?: string
}
// The minimal multer file shape the upload routes read (mirrors vendor-edge's
// UploadedJson, extended with originalname): the raw bytes plus the client
// filename the TMS adapter uses to detect .csv vs .xlsx. Avoids an
// @types/multer dependency for two fields.
interface UploadedSheet {
  buffer: Buffer
  originalname: string
}
// The bank/branch logo upload's multer file shape: same two fields as
// UploadedSheet plus mimetype (the AssetStore port's AssetMeta.contentType),
// which the sheet uploads never needed (TMS re-detects .csv/.xlsx from
// content, not the multipart mimetype).
interface UploadedLogoFile {
  buffer: Buffer
  originalname: string
  mimetype: string
}
// Task 6 (M2 dispatch trim ruling): the dispatch-artwork master upload body.
// Same tenantWire/bankCode/branchCode posture as BankConfigUpsertBody above
// (legitimate request inputs, platform master data). `group` selects which
// column the master lands on and is validated to the two literals below
// BEFORE the domain call (a 400, not a 500, on anything else); the file's
// PDF-ness and page-box trim match are the domain's own job (OpsClientError).
interface BankTemplateMasterUploadBody {
  tenantWire: string
  bankCode: string
  branchCode?: string
  group: string
}
// Phase 5 Task 1 (D-G, FR-01a): the device-inventory upload's non-file field.
// manufacturerVndrId is a RATIFIED VALIDATED BODY REFERENCE (a vndr_ wire id),
// NOT a principal scope (D99, M7/S16 do not apply): the class-3 all-programs
// ops principal has no vendor scope of its own to pin against, so the target
// manufacturer travels in the request and the fulfillment service validates
// it server-side (type='MANUFACTURER') before any write.
interface DeviceInventoryUploadBody {
  manufacturerVndrId: string
}
// D-17 (T5.1): the courier-status upload's non-file field. courierVndrId is the
// same kind of VALIDATED BODY REFERENCE as manufacturerVndrId above and for the
// same reason: an ops principal carries no vendor scope, the file arrived by
// email with the courier's name on it rather than with its credential, and the
// fulfillment service checks server-side that the id is a COURIER before any
// write. Naming the wrong courier quarantines every row, never moves a parcel.
interface CourierStatusUploadBody {
  courierVndrId: string
}

interface ResolveQuarantineBody {
  correctedRow: BankRequestRow
}
interface ResolveIntakeExceptionBody {
  correctedSheet: IntakeSheet
}
interface ResolveStatusExceptionBody {
  shptId: string
  status: string
  courierTimestamp: string
}

// The result of the shared edge gate: only the values a mutation route needs to
// call its domain op (the client action key and the actor re-derived from the
// claim) plus the correlation traceId.
interface Gated {
  clientKey: string
  actorId: string
  traceId: string
}

// The class-3 ops MUTATION edge (spec 10c, Task 9; CC-1 co-commit correction,
// S15). @UseGuards is declared at the CLASS level so EVERY route is
// authenticated by construction (never rely on a per-method guard a future
// route could forget). Every mutation runs the same gate (Fork D client action
// key -> optional per-action STEP-UP -> D2 authorize).
//
// The 6e split (S15 ruling):
//  - The ALLOW 6e for every ops mutation is a sensitive operation (and the
//    terminal override a privileged action), so it is enqueued INSIDE the
//    domain transaction by the domain op itself, COMMITTED-WITH-THE-OPERATION
//    (co-commit). The edge NO LONGER emits the ALLOW. Each mutation route just
//    passes the domain op the audit inputs it needs (for overrideTerminal: the
//    step-up assurance acr / auth_time read off the verified claim).
//  - The DENY 6e (authz-deny, step-up-required, and the defensive
//    step-up-misconfigured) has NO domain tx and stays edge-emitted, but is now
//    emitted DURABLY (its own short committed tx) and is NEVER swallowed: a
//    failed DENY enqueue propagates (a 500 is acceptable for a lost DENY audit;
//    the rejection had no effect, so there is no duplicate risk).
//
// The guard's authn-DENY (emitOpsAuthnDeny in guard.ts) is deliberately LEFT
// best-effort: it is the 401 authentication-layer event, matching the ratified
// 10a/10b precedent; the S15 ruling names only the authz-deny / step-up-required
// ACTION DENYs handled here, not the authentication-layer 401.
//
// IDs and enums only ride the 6e; PII and free text never leave the domain row.
@Controller('ops')
@UseGuards(OpsEdgeGuard)
export class OpsController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: OpsEdgeDeps) {}

  // The shared mutation gate (template steps b-d). Order is fixed: the client
  // action key (Fork D) is required first (a 400, never a 6e); THEN, if the
  // operation is in OPS_STEP_UP_CATALOG, the per-action step-up freshness/acr
  // gate (a step-up-required 6e DENY on failure); THEN the D2 two-gate authorize
  // (a decision.reason 6e DENY on failure). A DENY short-circuits before any
  // domain op runs, so a rejected action has ZERO domain effect.
  //
  // CC-1 (S15): a DENY 6e is emitted DURABLY via a direct
  // `emitOpsAuthzAudit` (its own short COMMITTED tx) and is NEVER swallowed. If
  // that durable enqueue fails, the error propagates (a 500 for a lost DENY
  // audit is acceptable: the rejection had no domain effect, so there is no
  // duplicate risk, and a silently-dropped DENY audit is the worse outcome for
  // a tamper-evident authz chain). This is the deliberate counterpart to the
  // guard's authn-DENY, which stays best-effort (the 401 authentication-layer
  // event, ratified 10a/10b precedent). The presented token / error body is
  // never logged or placed in the record (S4/5c).
  private async gate(
    req: EdgeRequest,
    operation: string,
    idempotencyKey: string | undefined,
    resourceIds: string[],
    stepUpKey?: keyof typeof OPS_STEP_UP_CATALOG,
  ): Promise<Gated> {
    const actorId = req.claim.sub
    const clientKey = idempotencyKey
    if (clientKey === undefined || clientKey.trim() === '') {
      throw new BadRequestException('Idempotency-Key header is required')
    }

    if (stepUpKey !== undefined) {
      const entry = OPS_STEP_UP_CATALOG[stepUpKey]
      // Fail closed on a missing catalog entry (a server misconfiguration).
      // With `stepUpKey` now typed `keyof typeof OPS_STEP_UP_CATALOG` (Fix wave
      // 1, Minor 4), a typo'd key is a COMPILE error at every call site, so
      // this branch is unreachable for any call site that compiles. It is kept
      // as a defensive RUNTIME guard (e.g. a future catalog entry deleted out
      // from under a still-referencing key): even then, a rejected mutation
      // must never have zero audit trail, so a DURABLE DENY 6e (its own
      // committed tx, never swallowed) is emitted before the throw, exactly
      // like every other DENY below.
      if (entry === undefined) {
        await emitOpsAuthzAudit(this.deps.fulfillmentDb, {
          principalId: actorId,
          operation,
          decision: 'DENY',
          outcome: 'denied',
          reasonCode: 'step-up-misconfigured',
          resourceIds,
          traceId: req.traceId,
        })
        throw new ForbiddenException()
      }
      try {
        requireStepUp(req.claim, entry, nowSec())
      } catch {
        await emitOpsAuthzAudit(this.deps.fulfillmentDb, {
          principalId: actorId,
          operation,
          decision: 'DENY',
          outcome: 'denied',
          reasonCode: 'step-up-required',
          resourceIds,
          traceId: req.traceId,
        })
        throw new ForbiddenException()
      }
    }

    const decision = authorize(req.claim, operation, {}, this.deps.roleConfig)
    if (!decision.allowed) {
      await emitOpsAuthzAudit(this.deps.fulfillmentDb, {
        principalId: actorId,
        operation,
        decision: 'DENY',
        outcome: 'denied',
        reasonCode: decision.reason,
        resourceIds,
        traceId: req.traceId,
      })
      throw new ForbiddenException()
    }

    return { clientKey, actorId, traceId: req.traceId }
  }

  // The read-like authorize for the preview surface: a plain D2 authorize with
  // NO side effect. It emits no 6e on either outcome (persist-nothing), unlike
  // the mutation gate above: an ALLOW writes nothing, and a DENY throws a bare
  // 403 rather than a durable DENY 6e (that would be an outbox write). This is
  // the same no-audit posture the class-3 read plane uses; the authorize is
  // still run because the preview response returns decoded bank PII.
  //
  // UNCHANGED by the 2026-08-10 soundbox duplicate-VPA ruling, which made the
  // bank preview perform a read-only scan under tms_ops_read (the same posture
  // previewDamage has always had). A READ IS NOT PERSISTENCE: the persist-
  // nothing invariant this posture rests on is about WRITES (no quarantine_row,
  // ingest_file, inbox or outbox row, and no DENY 6e), and both preview routes
  // still write nothing at all. So no gate, no Idempotency-Key and no 6e is
  // added here.
  private authorizePreview(req: EdgeRequest, operation: string): void {
    const decision = authorize(req.claim, operation, {}, this.deps.roleConfig)
    if (!decision.allowed) throw new ForbiddenException()
  }

  // The bank-upload preview (D-K, spec P2 Task 2). Multipart raw file; the TMS
  // adapter parses it and runs the SAME S8 row validators the commit runs,
  // returning a per-row verdict. It PERSISTS NOTHING (no pending_row,
  // quarantine_row, ingest_file, inbox, or outbox is written) and logs no row
  // content, so it deliberately does NOT run the mutation gate: there is no
  // idempotency key (a pure read needs none), no co-committed ALLOW 6e, and no
  // durable DENY 6e (a DENY 6e is itself an outbox write, which the persist-
  // nothing invariant forbids). This mirrors the read-plane posture
  // (OpsReadController emits no 6e). The RESPONSE carries decoded bank PII, so a
  // direct D2 authorize still gates access in code and an unauthorized operator
  // gets a 403.
  //
  // Takes the tms db since the 2026-08-10 soundbox duplicate-VPA ruling: the
  // preview must show the verdict the COMMIT will reach, and that verdict needs
  // a read of what TMS already holds. previewBankFile does that read (and only
  // that read) under the read-only tms_ops_read role, exactly like previewDamage
  // below, so the persist-nothing posture is intact.
  @Post('uploads/bank/preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async previewBank(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedSheet | undefined,
  ): Promise<BankPreviewResult> {
    this.authorizePreview(req, 'ops:upload-bank-file')
    if (!file) throw new BadRequestException('missing file')
    return previewBankFile(this.deps.tmsDb, file.buffer, file.originalname)
  }

  // The bank-upload commit (D-K). Multipart raw file, re-parsed SERVER-SIDE by
  // TMS (never trusting client rows). Keeps the full mutation gate (mandatory
  // Idempotency-Key, D2 authorize, co-committed ALLOW 6e) and the same
  // guard-only, NOT step-up-gated posture the old JSON route carried. A file
  // that fails structural parse throws BankFileParseError (kind:'invalid'),
  // which the app-wide OpsErrorFilter maps to a 400.
  // qrMalformed (D-8) rides on the result: how many rows of THIS file arrived
  // with the bank's HTML-escaped QR separator. It is the evidence the D4 ruling
  // asks for in its own last line ("This is a compensating control for a
  // bank-side bug, not a fix. GSCB should still be told"), surfaced at the
  // moment the file is uploaded, which is the grain and the moment that
  // conversation needs. Additive: no existing field changed.
  // duplicateVpaHeld (ruling 2026-08-10) rides on the result the same way: the
  // soundbox rows this file HELD for a repeat VPA, each naming the record it
  // collides with, so the portal can list them instead of only counting them.
  // Additive too: duplicateVpa keeps counting every repeat, held or not.
  @Post('uploads/bank/commit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async commitBank(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedSheet | undefined,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{
    accepted: number
    quarantined: number
    duplicate: number
    qrMalformed: number
    duplicateVpa: number
    duplicateMobile: number
    duplicateVpaHeld: { rowNo: number; duplicateOf: DuplicateVpaOriginal }[]
    fileId: string
  }> {
    const g = await this.gate(req, 'ops:upload-bank-file', idem, [])
    if (!file) throw new BadRequestException('missing file')
    return commitBankFile(this.deps.tmsDb, {
      fileBytes: file.buffer,
      filename: file.originalname,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // Phase 5 Task 1 (D-G, FR-01a): the ops device-inventory upload, the ops
  // analog of the vendor-channel manufacturer intake. Mirrors commitBank's
  // multipart/gate/re-parse posture exactly (mandatory Idempotency-Key, D2
  // authorize, co-committed ALLOW 6e); the SERVER-SIDE re-parse and the
  // manufacturer-vndr validation both happen inside the fulfillment service
  // function (ingestOpsDeviceInventory), never trusting client-sent rows. A
  // structural parse failure or an invalid/missing manufacturerVndrId surfaces
  // as the fulfillment domain's OpsClientError, which the app-wide
  // OpsErrorFilter maps to a 4xx.
  // PREVIEW: parses and compares against stock, writes nothing, so it takes NO
  // Idempotency-Key (there is nothing to make idempotent), exactly like the
  // bank preview. DP-9 (D-29, 16 Aug 2026): it DOES run the same persist-
  // nothing authorizePreview the bank preview runs, on this upload's own
  // permission, because the preview response echoes the sheet's contents and a
  // restricted role (customer_support carries no upload permissions) must not
  // read sheet contents through a preview it could never commit.
  @Post('uploads/device-inventory/preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async previewDeviceInventory(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedSheet | undefined,
  ): Promise<OpsDeviceInventoryPreview> {
    this.authorizePreview(req, 'ops:upload-device-inventory')
    if (!file) throw new BadRequestException('missing file')
    return previewOpsDeviceInventory(this.deps.fulfillmentDb, {
      fileBytes: file.buffer,
      filename: file.originalname,
    })
  }

  @Post('uploads/device-inventory')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async uploadDeviceInventory(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedSheet | undefined,
    @Body() body: DeviceInventoryUploadBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<OpsDeviceInventoryResult> {
    const g = await this.gate(req, 'ops:upload-device-inventory', idem, [])
    if (!file) throw new BadRequestException('missing file')
    return ingestOpsDeviceInventory(this.deps.fulfillmentDb, {
      fileBytes: file.buffer,
      filename: file.originalname,
      manufacturerVndrId: body.manufacturerVndrId,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // D-17 (T5.1, 13 Aug 2026): the courier's morning status file, uploaded by
  // ops. The walkthrough's Phase-1 courier story is an emailed spreadsheet, and
  // the existing batch path is JSON on a vendor-credentialed route, which no
  // inbox can authenticate. Same multipart/gate/re-parse posture as the
  // device-inventory upload: the SERVER re-parses the bytes and validates the
  // courier reference inside the fulfillment service, never trusting
  // client-sent rows.
  @Post('uploads/courier-status')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async uploadCourierStatus(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedSheet | undefined,
    @Body() body: CourierStatusUploadBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<OpsCourierStatusResult> {
    const g = await this.gate(req, 'ops:upload-courier-status', idem, [])
    if (!file) throw new BadRequestException('missing file')
    return ingestOpsCourierStatus(this.deps.fulfillmentDb, {
      fileBytes: file.buffer,
      filename: file.originalname,
      courierVndrId: body.courierVndrId,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // Bulk unit-status correction, the sheet-upload sibling of PATCH-by-hand
  // above. PREVIEW writes nothing, same posture as the device-inventory
  // preview: no Idempotency-Key, and (DP-9, D-29) the same persist-nothing
  // authorizePreview on this upload's own permission, because a restricted
  // role must not read sheet contents through a preview it cannot commit.
  @Post('uploads/unit-status/preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async previewUnitStatus(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedSheet | undefined,
  ): Promise<OpsUnitStatusPreview> {
    this.authorizePreview(req, 'ops:upload-unit-status')
    if (!file) throw new BadRequestException('missing file')
    return previewOpsUnitStatus(this.deps.fulfillmentDb, { fileBytes: file.buffer, filename: file.originalname })
  }

  @Post('uploads/unit-status')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async uploadUnitStatus(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedSheet | undefined,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<OpsUnitStatusResult> {
    const g = await this.gate(req, 'ops:upload-unit-status', idem, [])
    if (!file) throw new BadRequestException('missing file')
    return ingestOpsUnitStatus(this.deps.fulfillmentDb, {
      fileBytes: file.buffer,
      filename: file.originalname,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // D-25 (13 Aug 2026; escalation decided 2026-08-11, option A). The print
  // vendor's return sheet, uploaded by an OPERATOR. BRD FR-05 para 322 makes
  // this the Phase-1 channel outright: "In Phase 1, return file would be sent
  // via email and uploaded into system by AndPayments team." POST /vendor/return
  // stays exactly as it is and remains the Phase-2 surface; the two channels
  // share one ingest body so they cannot drift.
  //
  // Same posture as every other ops upload here: the SERVER re-parses the bytes
  // and never trusts client-sent rows, and the print vendor is resolved inside
  // the fulfillment service from batch.print_vndr, so there is no @Body() and
  // nothing an operator can assert about whose sheet this is (M7, S16, 105c).
  //
  // The preview writes nothing, so like the device-inventory and unit-status
  // previews it takes no Idempotency-Key, and (DP-9, D-29) it runs the same
  // persist-nothing authorizePreview on this upload's own permission: a
  // restricted role must not read sheet contents through a preview it cannot
  // commit. It exists so a mixed-vendor or unbound-batch file is refused on
  // screen before the operator commits it.
  @Post('uploads/return/preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async previewReturnUpload(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedSheet | undefined,
  ): Promise<ReturnSheetParseResult> {
    this.authorizePreview(req, 'ops:upload-return-file')
    if (!file) throw new BadRequestException('missing file')
    return parseReturnWorkbook(new Uint8Array(file.buffer), file.originalname ?? '')
  }

  @Post('uploads/return')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async uploadReturn(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedSheet | undefined,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<OpsReturnResult & { invalidRows: ReturnSheetParseResult['invalidRows'] }> {
    const g = await this.gate(req, 'ops:upload-return-file', idem, [])
    if (!file) throw new BadRequestException('missing file')
    const parsed = await parseReturnWorkbook(new Uint8Array(file.buffer), file.originalname ?? '')
    // A structural failure is a whole-file refusal, and it is the operator's to
    // fix in the spreadsheet, so it answers 400 with the reasons rather than 200
    // with a zero-count success that reads like the file was accepted.
    if (parsed.structuralErrors.length > 0) {
      throw new BadRequestException(parsed.structuralErrors.map((e) => e.message).join(' '))
    }
    // The file identity is the bytes, so an ops upload and the vendor's own
    // upload of the same attachment dedup against each other rather than pairing
    // every device twice.
    const fileId = createHash('sha256').update(file.buffer).digest('hex')
    const result = await ingestReturnSheetOps(this.deps.fulfillmentDb, { fileId, rows: parsed.validRows })
    void g
    return { ...result, invalidRows: parsed.invalidRows }
  }

  @Post('shipments/:id/correct')
  @HttpCode(200)
  async correct(
    @Req() req: EdgeRequest,
    @Param('id') id: string,
    @Body() body: CorrectBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; outcome: string | null }> {
    const g = await this.gate(req, 'ops:status-correction', idem, [id])
    // Defense-in-depth (this write path advances shpt.status): reject an unknown
    // target status BEFORE the domain op runs.
    if (!isKnownStatus(body.status)) throw new BadRequestException('unknown status')
    const result = await correctStatus(this.deps.fulfillmentDb, {
      shptId: id,
      status: body.status,
      courierTimestamp: new Date(body.courierTimestamp),
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    return result
  }

  // Manual unit-status correction (2026-08-13 ruling): the device page's edit
  // control. Not step-up-gated: the forward-only guard inside correctUnitStatus
  // is what limits the blast radius (it can move a device forward, including
  // into a terminal branch, but can never leave one and never move backward),
  // the same reasoning `ops:status-correction` above already rests on.
  @Post('units/:id/status')
  @HttpCode(200)
  async correctUnit(
    @Req() req: EdgeRequest,
    @Param('id') id: string,
    @Body() body: UnitStatusBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; advanced: boolean }> {
    const g = await this.gate(req, 'ops:unit-status-correction', idem, [id])
    if (!KNOWN_UNIT_STATUSES.includes(body.status)) throw new BadRequestException('unknown status')
    return correctUnitStatus(this.deps.fulfillmentDb, {
      unitId: id,
      status: body.status,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  @Post('shipments/:id/override')
  @HttpCode(200)
  async override(
    @Req() req: EdgeRequest,
    @Param('id') id: string,
    @Body() body: OverrideBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; overridden: boolean }> {
    const g = await this.gate(req, 'ops:terminal-override', idem, [id], 'terminal-override')
    // Defense-in-depth: the override writes shpt.status raw (the sanctioned C3
    // bypass), so an unknown target status is rejected here too, before the op.
    if (!isKnownStatus(body.status)) throw new BadRequestException('unknown status')
    // CC-1: the domain op co-commits the privileged-action ALLOW 6e INSIDE its
    // own transaction. The edge passes the step-up assurance (acr, auth_time)
    // read off the verified claim so the co-committed record can carry it; the
    // free-text overrideReason lives ONLY on the domain row (DD1) and never
    // rides the 6e.
    const result = await overrideTerminal(this.deps.fulfillmentDb, {
      shptId: id,
      status: body.status,
      courierTimestamp: new Date(body.courierTimestamp),
      overrideReason: body.overrideReason,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
      ...(req.claim.acr !== undefined ? { acr: req.claim.acr } : {}),
      ...(req.claim.auth_time !== undefined ? { authTime: req.claim.auth_time } : {}),
    })
    return result
  }

  @Post('artifacts/recompose')
  @HttpCode(200)
  async recompose(
    @Req() req: EdgeRequest,
    @Body() body: RecomposeBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; artifactId: string | null }> {
    const g = await this.gate(req, 'ops:recompose-artifact', idem, [body.asgnId])
    const result = await recomposeArtifact(this.deps.fulfillmentDb, {
      asgnId: body.asgnId,
      artifactType: body.artifactType,
      ...(body.requestedShipTo !== undefined ? { requestedShipTo: body.requestedShipTo } : {}),
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    return result
  }

  @Post('records/:asgnId/hold')
  @HttpCode(200)
  async hold(
    @Req() req: EdgeRequest,
    @Param('asgnId') asgnId: string,
    @Body() body: HoldBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean }> {
    // Validated BEFORE this.gate, exactly as the batch-trigger reason is and for
    // the same reason: a malformed request must never put an ALLOW on the hash
    // chain for an action that then fails. The domain re-checks it, which is the
    // guarantee that holds for every caller; this check is what produces the
    // operator-facing 400.
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    if (reason === '') throw new BadRequestException('reason is required')
    if (reason.length > MAX_TRIGGER_REASON_LENGTH) {
      throw new BadRequestException(`reason must be at most ${MAX_TRIGGER_REASON_LENGTH} characters`)
    }
    const g = await this.gate(req, 'ops:record-hold', idem, [asgnId])
    const result = await holdRecord(this.deps.fulfillmentDb, {
      asgnId,
      reason,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    return result
  }

  @Post('records/:asgnId/release')
  @HttpCode(200)
  async release(
    @Req() req: EdgeRequest,
    @Param('asgnId') asgnId: string,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; released: boolean }> {
    const g = await this.gate(req, 'ops:record-release', idem, [asgnId], 'hold-release')
    const result = await releaseRecord(this.deps.fulfillmentDb, {
      asgnId,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    return result
  }

  // FR08-2 (BRD 5.8): transition a replacement's damage case_status. Target
  // asgnId is a wire id in the path; the service decodes it (toUuid) and the
  // body carries the new status plus an optional operator note (D99, M7/S16:
  // no actor/scope in the body).
  //
  // D-24 (T6.5) spells the middle state "In Progress" while the column stores
  // "In-Progress"; the domain normalizes on whitespace and case, so a caller
  // may send either and neither spelling is a client error.
  @Post('records/:asgnId/damage-case-status')
  @HttpCode(200)
  async updateDamageCase(
    @Req() req: EdgeRequest,
    @Param('asgnId') asgnId: string,
    @Body() body: DamageCaseStatusBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean }> {
    const g = await this.gate(req, 'ops:update-damage-case', idem, [asgnId])
    return updateDamageCaseStatusOps(this.deps.tmsDb, {
      asgnId,
      newStatus: body.status,
      ...(typeof body.opsRemarks === 'string' ? { opsRemarks: body.opsRemarks } : {}),
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // D-26/D-27/D-28 (DAMAGE_PLAN B5, supersedes the deleted damage file upload):
  // the operator flags ONE dispatched leg as damaged and TMS mints the
  // non-billable replacement child in the same transaction (billable=false,
  // case_status='Open', the replacement_raised fact, the demand fact, the
  // co-committed ALLOW 6e in the TMS outbox). The child's dispatch_group is
  // inherited from the flagged leg (DP-2), so there is no group input here.
  //
  // The body is validated BEFORE this.gate, exactly as the batch-trigger reason
  // and the hold reason are and for the same reason: a malformed request must
  // never put an ALLOW on the hash chain for an action that then 400s. The
  // domain re-validates everything (active reason code, leg/count semantics,
  // the DP-3 one-live-case rule), which is the guarantee that holds for every
  // caller; these checks produce the operator-facing 400 message.
  //
  // Error mapping rides the app-wide OpsErrorFilter: the domain's not-found
  // (unknown asgn) maps to 404 and its conflict (a non-Closed child already
  // exists, DP-3) maps to 409, the same way the neighboring routes' domain
  // errors map. 201 on success: a child assignment was CREATED, unlike the
  // sibling 200 status-transition route above.
  @Post('records/:asgnId/flag-damage')
  @HttpCode(201)
  async flagDamage(
    @Req() req: EdgeRequest,
    @Param('asgnId') asgnId: string,
    @Body() body: FlagDamageBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<FlagDamageResult> {
    const reasonCode = typeof body?.reasonCode === 'string' ? body.reasonCode.trim() : ''
    if (reasonCode === '') throw new BadRequestException('reasonCode is required')
    const remarks = typeof body?.remarks === 'string' ? body.remarks.trim() : ''
    if (remarks === '') throw new BadRequestException('remarks are required')
    if (remarks.length > MAX_FLAG_REMARKS_LENGTH) {
      throw new BadRequestException(`remarks must be at most ${MAX_FLAG_REMARKS_LENGTH} characters`)
    }
    for (const [name, value] of [
      ['standeeCount', body?.standeeCount],
      ['stickerCount', body?.stickerCount],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 99)) {
        throw new BadRequestException(`${name} must be an integer between 0 and 99`)
      }
    }
    const g = await this.gate(req, 'ops:flag-damage', idem, [asgnId])
    return flagDamageOps(this.deps.tmsDb, {
      asgnId,
      reasonCode,
      remarks,
      ...(body.standeeCount !== undefined ? { standeeCount: body.standeeCount } : {}),
      ...(body.stickerCount !== undefined ? { stickerCount: body.stickerCount } : {}),
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // Phase 5 Task 2 (D-H.1, BRD Phase-1 MANUAL activation flow): CWD activates
  // the device+SIM out of band; ops marks it here.
  //
  // THE DELIVERED GATE IS GONE (D-16, T4.2, 13 Aug 2026). It used to reject any
  // assignment whose projected row carried no delivery date, and that encoded
  // the linear lifecycle D-16 retires: delivery and activation are independent
  // axes, and the CWD routinely confirms an activation before the courier's
  // morning file reaches us. The gate turned that ordinary sequence into a
  // conflict an operator could do nothing about except wait for a file that had
  // no bearing on whether the device was live. It was also a gate on an
  // EVENTUALLY CONSISTENT read: the projection lagging made a delivered device
  // un-activatable for as long as the lag lasted.
  //
  // ONE GATE REMAINS, and it is about the thing itself rather than its
  // schedule: paper does not activate (W-5). A COLLATERAL group's lifecycle
  // ends at DELIVERED, so activating it by hand must be impossible, not merely
  // absent from the worklist.
  //
  // A row with no projection at all is still refused, and deliberately: the
  // remaining gate cannot be evaluated without it, and guessing a dispatch group
  // is how a standee gets activated. Fail closed.
  //
  // Both refusals are normal business-rule 409s, not authz DENYs: the D2
  // authorize already ALLOWed inside gate() above, and since the domain op never
  // runs, no 6e (ALLOW or DENY) is emitted for the rejection. The activation
  // itself goes through a fresh ManualDevicePort (R4: Phase-1 has no CWD-API
  // adapter wired, C6/T11 seam preserved).
  @Post('assignments/activate')
  @HttpCode(200)
  async activateAssignmentRoute(
    @Req() req: EdgeRequest,
    @Body() body: ActivateAssignmentBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ activated: boolean }> {
    const g = await this.gate(req, 'ops:mark-activated', idem, [])
    const status = await readDispatchActivationStatus(this.deps.analyticsDb, body.dispatchId)
    if (status === null) {
      throw new ConflictException('unknown-dispatch')
    }
    if (status.dispatchGroup === 'COLLATERAL') {
      throw new ConflictException('not-activatable')
    }
    return activateAssignmentOps(this.deps.tmsDb, {
      asgnId: body.dispatchId,
      port: new ManualDevicePort(),
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // D-16 (T4.1b, 13 Aug 2026): record that the activation request for these
  // dispatch ids has LEFT US for the CWD. This is the window an operator chases,
  // between asking and being told, and nothing could express it before.
  //
  // A POST rather than a side effect of GET /ops/reports/activation, which is
  // where D-16's literal wording would put it: that route is a pinned pure read,
  // and a mutating GET is retried by proxies and prefetched by browsers. The
  // domain write is the same function either way, so the trigger can move later
  // at the cost of a route and no state (PLAN.md Q24).
  //
  // Shape validation only, here. Nothing about WHICH ids are legitimate is
  // decided at the edge: TMS resolves each assignment and its program
  // server-side (D99) and reports back the ones it did not recognise.
  @Post('assignments/request-activation')
  @HttpCode(200)
  async requestActivationRoute(
    @Req() req: EdgeRequest,
    @Body() body: RequestActivationBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; recorded: string[]; unknown: string[] }> {
    const ids = Array.isArray(body?.dispatchIds) ? body.dispatchIds.filter((id) => typeof id === 'string') : []
    if (ids.length === 0) {
      throw new BadRequestException('dispatchIds must be a non-empty array')
    }
    const g = await this.gate(req, 'ops:request-activation', idem, ids)
    return requestActivationOps(this.deps.tmsDb, {
      asgnIds: ids,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // D-19 (T5.4, 13 Aug 2026): mark SEVERAL dispatches activated in one action.
  //
  // THIS REVERSES A RECORDED REFUSAL, and it is worth being precise about what
  // was refused. ActivationStage.tsx said: "NO MARK-ALL BUTTON, deliberately...
  // a Mark all here could only be a CLIENT-SIDE LOOP. A loop that fails halfway
  // leaves the operator unable to tell which records went through: the screen
  // would have claimed an action it only partly took. Rejected on that ground,
  // not on effort." That objection was right, and the walkthrough ruling bulk
  // marking in does not make it wrong. So the fix is the server-side write the
  // refusal said did not exist, returning a RESULT PER ROW: nothing is claimed
  // that did not happen, and a row that failed says so next to the rows that
  // succeeded.
  //
  // Each row is INDEPENDENT: its own transaction, its own gates, its own 6e.
  // One failure never rolls back the rows around it, because a partial success
  // faithfully reported is better than an all-or-nothing that loses twenty-nine
  // good marks to one bad id.
  //
  // Idempotency does not depend on the client key here. The underlying write
  // dedups on the BUSINESS key `${asgnId}|activate` (activateAssignmentWithinTx),
  // so re-sending a batch re-marks nothing whatever key it carries. The header
  // is still required, because every mutation on this edge requires one.
  @Post('assignments/activate-bulk')
  @HttpCode(200)
  async activateAssignmentsBulk(
    @Req() req: EdgeRequest,
    @Body() body: BulkActivateBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ results: { dispatchId: string; activated: boolean; reason: string | null }[] }> {
    const ids = Array.isArray(body?.dispatchIds) ? body.dispatchIds.filter((id) => typeof id === 'string') : []
    if (ids.length === 0) {
      throw new BadRequestException('dispatchIds must be a non-empty array')
    }
    const g = await this.gate(req, 'ops:mark-activated', idem, ids)

    return { results: await this.activateEach(ids, g) }
  }

  // The per-row activation shared by the bulk route above and the activation
  // FILE upload below. One copy, because the two differ only in where their list
  // of dispatch ids came from, and the gates a row passes must not depend on
  // that. Every row is independent: its own transaction, its own gates, its own
  // 6e, and a failure never rolls back its neighbours.
  private async activateEach(
    dispatchIds: string[],
    g: { clientKey: string; actorId: string; traceId: string },
  ): Promise<ActivationRowResult[]> {
    const results: ActivationRowResult[] = []
    for (const dispatchId of dispatchIds) {
      // The SAME checks the single route applies, per row. Expressed here rather
      // than by calling that route's handler because a thrown ConflictException
      // would end the batch, which is exactly what these routes exist to avoid:
      // the reason has to survive as data, not as an exception.
      const status = await readDispatchActivationStatus(this.deps.analyticsDb, dispatchId)
      if (status === null) {
        results.push({ dispatchId, activated: false, reason: 'unknown-dispatch' })
        continue
      }
      if (status.dispatchGroup === 'COLLATERAL') {
        results.push({ dispatchId, activated: false, reason: 'not-activatable' })
        continue
      }
      const r = await activateAssignmentOps(this.deps.tmsDb, {
        asgnId: dispatchId,
        port: new ManualDevicePort(),
        clientKey: g.clientKey,
        actorId: g.actorId,
        traceId: g.traceId,
      })
      // `activated: false` is the already-activated case: the business-key dedup
      // refused a second mark. Not an error and not a success, so it is reported
      // as neither.
      results.push({ dispatchId, activated: r.activated, reason: r.activated ? null : 'already-activated' })
    }
    return results
  }

  // D-19 (T5.5, 13 Aug 2026): the CWD's ACTIVATION FILE, uploaded by ops.
  //
  // THE FILE NAMES DEVICES AND THE PLATFORM ACTIVATES ASSIGNMENTS, so the serial
  // has to be resolved back to the dispatch it was printed for. That link is
  // fulfillment's `unit.asgn_id` while the write is TMS's, so the EDGE composes
  // the two reads: one resolution, then the same per-row activation the bulk
  // route uses. No service reads another's tables (C4).
  //
  // A serial the platform cannot place is reported as its own row outcome rather
  // than dropped. The CWD reported an activation for it, and losing that report
  // silently is how a device ends up with no recorded outcome and nobody notices.
  @Post('uploads/activation')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async uploadActivation(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedSheet | undefined,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{
    activated: number
    invalid: number
    invalidRows: ActivationFileRowError[]
    results: (ActivationRowResult & { deviceId: string })[]
  }> {
    const g = await this.gate(req, 'ops:mark-activated', idem, [])
    if (!file) throw new BadRequestException('missing file')

    const parsed = await parseActivationFile(file.buffer, file.originalname)
    if (parsed.structuralErrors.length > 0) {
      // The CODE and, for a missing column, its canonical name. The adapter's
      // `message` embeds the operator's filename and must never ride a response
      // (S4/5c).
      throw new BadRequestException({
        message: 'activation file failed structural parse',
        reasons: parsed.structuralErrors.map((e) =>
          e.column === undefined ? { code: e.code } : { code: e.code, column: e.column },
        ),
      })
    }

    const serials = parsed.validRows.map((r) => r.deviceId)
    const bySerial = await resolveAssignmentsByDeviceSerial(this.deps.fulfillmentDb, serials)

    const results: (ActivationRowResult & { deviceId: string })[] = []
    for (const deviceId of serials) {
      const dispatchId = bySerial.get(deviceId)
      if (dispatchId === undefined) {
        results.push({ deviceId, dispatchId: '', activated: false, reason: 'unknown-device' })
        continue
      }
      const [outcome] = await this.activateEach([dispatchId], g)
      results.push({ deviceId, ...outcome! })
    }

    return {
      activated: results.filter((r) => r.activated).length,
      invalid: parsed.invalidRows.length,
      invalidRows: parsed.invalidRows,
      results,
    }
  }

  @Post('batches/trigger')
  @HttpCode(200)
  async batchTrigger(
    @Req() req: EdgeRequest,
    @Body() body: BatchTriggerBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ btchId: string } | null> {
    // BRD 5.3.4: validated BEFORE this.gate, unlike the isKnownStatus checks on
    // the correct/override routes, and the ordering is the point. A request with
    // no reason is a malformed request, not a rejected authorization: running
    // the D2 gate first would co-commit an ALLOW 6e for an attempt that then
    // 400s and does nothing, putting a permanent authorized-action record on the
    // hash chain for an action that never happened. Checking first means a
    // missing reason emits no 6e at all, ALLOW or DENY.
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason === '') {
      throw new BadRequestException('a reason is required to trigger a batch manually')
    }
    if (reason.length > MAX_TRIGGER_REASON_LENGTH) {
      throw new BadRequestException(`the reason must be at most ${MAX_TRIGGER_REASON_LENGTH} characters`)
    }

    const g = await this.gate(req, 'ops:manual-batch-trigger', idem, [body.tenantWire, body.programWire])
    const result = await manualBatch(this.deps.fulfillmentDb, {
      tenantWire: body.tenantWire,
      programWire: body.programWire,
      // The TRIMMED value. The domain re-validates it (manualBatch throws
      // OpsClientError on a blank or overlong reason regardless of caller); this
      // check exists so the operator gets a clear 400 message instead of the
      // filter's generic one.
      reason,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    return result
  }

  @Post('vendors')
  @HttpCode(200)
  async createVendor(
    @Req() req: EdgeRequest,
    @Body() body: VendorCreateBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; vndrId: string | null }> {
    const g = await this.gate(req, 'ops:vendor-create', idem, [])
    const result = await createVendorOps(this.deps.fulfillmentDb, {
      type: body.type,
      displayName: body.displayName,
      ...(body.courierCode !== undefined ? { courierCode: body.courierCode } : {}),
      ...(body.integrationMode !== undefined ? { integrationMode: body.integrationMode } : {}),
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    return result
  }

  @Post('vendors/:id/suspend')
  @HttpCode(200)
  async suspendVendorRoute(
    @Req() req: EdgeRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean }> {
    const g = await this.gate(req, 'ops:vendor-suspend', idem, [id], 'vendor-suspend')
    const result = await suspendVendor(this.deps.fulfillmentDb, {
      vndrId: id,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    return result
  }

  // Phase 3 Task 2 (BRD FR-11): the courier master edit route. Mirrors the
  // suspend route's guard/authz/idempotency posture; NOT step-up-gated, same
  // as create (master-data maintenance, not a destructive action).
  @Post('vendors/:id/edit')
  @HttpCode(200)
  async editVendorRoute(
    @Req() req: EdgeRequest,
    @Param('id') id: string,
    @Body() body: VendorEditBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean }> {
    const g = await this.gate(req, 'ops:vendor-edit', idem, [id])
    const result = await editVendorOps(this.deps.fulfillmentDb, {
      vndrId: id,
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.courierCode !== undefined ? { courierCode: body.courierCode } : {}),
      ...(body.integrationMode !== undefined ? { integrationMode: body.integrationMode } : {}),
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    return result
  }

  // Phase 3 Task 1 (BRD FR-08, FR-11): the damage_reason master admin CRUD.
  // No step-up (not in OPS_STEP_UP_CATALOG): this is reference-data config, not
  // a destructive vendor/shipment action, matching create/vendor-create's own
  // no-step-up posture. Every mutation keeps the same gate (Idempotency-Key,
  // D2 authorize, co-committed ALLOW 6e) as every other ops mutation above.
  @Post('damage-reasons')
  @HttpCode(200)
  async createDamageReason(
    @Req() req: EdgeRequest,
    @Body() body: DamageReasonCreateBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; damageReason: DamageReasonRow | null }> {
    const g = await this.gate(req, 'ops:damage-reason-create', idem, [])
    const result = await createDamageReasonOps(this.deps.tmsDb, {
      code: body.code,
      label: body.label,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    return result
  }

  @Post('damage-reasons/:id/activate')
  @HttpCode(200)
  async activateDamageReasonRoute(
    @Req() req: EdgeRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean }> {
    const g = await this.gate(req, 'ops:damage-reason-activate', idem, [id])
    const result = await activateDamageReasonOps(this.deps.tmsDb, {
      id,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    return result
  }

  @Post('damage-reasons/:id/deactivate')
  @HttpCode(200)
  async deactivateDamageReasonRoute(
    @Req() req: EdgeRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean }> {
    const g = await this.gate(req, 'ops:damage-reason-deactivate', idem, [id])
    const result = await deactivateDamageReasonOps(this.deps.tmsDb, {
      id,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    return result
  }

  @Post('quarantine/:id/resolve')
  @HttpCode(200)
  async resolveQuarantine(
    @Req() req: EdgeRequest,
    @Param('id') id: string,
    @Body() body: ResolveQuarantineBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; outcome: string | null }> {
    const g = await this.gate(req, 'ops:resolve-quarantine', idem, [id])
    const result = await resolveQuarantineRow(this.deps.tmsDb, {
      quarantineId: id,
      correctedRow: body.correctedRow,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    return result
  }

  // D-8's OTHER action. It takes NO body, deliberately: closing a record is a
  // decision about the record as it stands, not a correction to it, so there is
  // nothing for the operator to supply and nothing for a caller to get wrong.
  // The gate still requires an Idempotency-Key like every other write here.
  @Post('quarantine/:id/close')
  @HttpCode(200)
  async closeQuarantine(
    @Req() req: EdgeRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; closed: boolean }> {
    const g = await this.gate(req, 'ops:close-quarantine', idem, [id])
    return closeQuarantineRow(this.deps.tmsDb, {
      quarantineId: id,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  @Post('intake-exceptions/:id/resolve')
  @HttpCode(200)
  async resolveIntakeExceptionRoute(
    @Req() req: EdgeRequest,
    @Param('id') id: string,
    @Body() body: ResolveIntakeExceptionBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; result: unknown }> {
    const g = await this.gate(req, 'ops:resolve-intake-exception', idem, [id])
    const result = await resolveIntakeException(this.deps.fulfillmentDb, {
      exceptionId: id,
      correctedSheet: body.correctedSheet,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    return result
  }

  @Post('status-exceptions/:id/resolve')
  @HttpCode(200)
  async resolveStatusExceptionRoute(
    @Req() req: EdgeRequest,
    @Param('id') id: string,
    @Body() body: ResolveStatusExceptionBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; outcome: string | null }> {
    const g = await this.gate(req, 'ops:resolve-status-exception', idem, [id])
    // Defense-in-depth: the resolve re-drives a status advance, so reject an
    // unknown target status BEFORE the domain op runs.
    if (!isKnownStatus(body.status)) throw new BadRequestException('unknown status')
    const result = await resolveStatusException(this.deps.fulfillmentDb, {
      exceptionId: id,
      shptId: body.shptId,
      status: body.status,
      courierTimestamp: new Date(body.courierTimestamp),
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    return result
  }

  // Phase 3 Task 5b (BRD Annexure D.4): the bank/branch composition-config
  // admin CRUD. Same gate/idempotency/co-committed-6e posture as every other
  // ops mutation above; NOT step-up-gated (not in OPS_STEP_UP_CATALOG),
  // matching vendor-create/damage-reason-create's own no-step-up posture
  // (reference-data / master-data configuration, not a destructive
  // vendor/shipment action).
  @Post('bank-config')
  @HttpCode(200)
  async upsertBankConfigRoute(
    @Req() req: EdgeRequest,
    @Body() body: BankConfigUpsertBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; id: string | null }> {
    const g = await this.gate(req, 'ops:template-config-set', idem, [])
    return upsertBankCompositionConfig(this.deps.fulfillmentDb, {
      tenantWire: body.tenantWire,
      bankCode: body.bankCode,
      ...(body.branchCode !== undefined ? { branchCode: body.branchCode } : {}),
      brandingParams: body.brandingParams,
      imageTemplates: body.imageTemplates,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // Multipart logo upload (mirrors the Phase-2 FileInterceptor + size-cap
  // pattern used by the bank/damage file uploads above). tenantWire/bankCode/
  // branchCode ride as ordinary multipart form fields alongside `file` (multer
  // populates req.body with them exactly like a JSON body's fields); the
  // actor/traceId/idempotency-key still come from the gate, never the body.
  // Stores via the injected T3 AssetStore port (deps.assetStore, the dev
  // adapter today) and persists the returned reference into logoMasterRef.
  @Post('bank-config/logo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async setBankLogoRoute(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedLogoFile | undefined,
    @Body() body: BankConfigUpsertBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; id: string | null; reference: string | null; version: string | null }> {
    const g = await this.gate(req, 'ops:bank-logo-set', idem, [])
    if (!file) throw new BadRequestException('missing file')
    return setBankLogo(this.deps.fulfillmentDb, this.deps.assetStore, {
      tenantWire: body.tenantWire,
      bankCode: body.bankCode,
      ...(body.branchCode !== undefined ? { branchCode: body.branchCode } : {}),
      bytes: file.buffer,
      contentType: file.mimetype,
      filename: file.originalname,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // Task 6 (M2 dispatch trim ruling): the dispatch-artwork master upload.
  // Same FileInterceptor/gate idiom as setBankLogoRoute above, gated on the
  // distinct 'ops:bank-template-master-set' operation. `group` rides as an
  // ordinary multipart form field (multer populates req.body with it exactly
  // like tenantWire/bankCode above) and is validated to the two literals here
  // at the edge, a 400 on anything else, BEFORE the domain call ever sees it.
  @Post('bank-config/template')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async setBankTemplateMasterRoute(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedLogoFile | undefined,
    @Body() body: BankTemplateMasterUploadBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; id: string | null; reference: string | null; version: string | null }> {
    const g = await this.gate(req, 'ops:bank-template-master-set', idem, [])
    if (!file) throw new BadRequestException('missing file')
    if (body.group !== 'SOUNDBOX' && body.group !== 'COLLATERAL') {
      throw new BadRequestException('group must be SOUNDBOX or COLLATERAL')
    }
    return setBankTemplateMaster(this.deps.fulfillmentDb, this.deps.assetStore, {
      tenantWire: body.tenantWire,
      bankCode: body.bankCode,
      ...(body.branchCode !== undefined ? { branchCode: body.branchCode } : {}),
      group: body.group,
      bytes: file.buffer,
      contentType: file.mimetype,
      filename: file.originalname,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // Phase 3 Task 6 (BRD 5.3.2): the batching-parameter admin write. Same
  // gate/idempotency/co-committed-6e posture as every other ops mutation; NOT
  // step-up-gated (not in OPS_STEP_UP_CATALOG, per the ratification). The
  // 'ops:batching-config-set' operation is granted ONLY to the admin /
  // super_admin roles (ops-config.ts), so a baseline `ops` operator is DENIED
  // here by the D2 authorize in the gate (the first per-role differentiation).
  // Domain-side validation (min/max >= 1) throws OpsClientError('invalid'),
  // which the app-wide OpsErrorFilter maps to a 400.
  @Post('batching-config')
  @HttpCode(200)
  async setBatchingConfigRoute(
    @Req() req: EdgeRequest,
    @Body() body: BatchingConfigSetBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; id: string | null }> {
    const g = await this.gate(req, 'ops:batching-config-set', idem, [])
    return upsertBatchingConfig(this.deps.fulfillmentDb, {
      ...(body.tenantWire !== undefined ? { tenantWire: body.tenantWire } : {}),
      ...(body.programWire !== undefined ? { programWire: body.programWire } : {}),
      ...(body.bankReferenceCode !== undefined ? { bankReferenceCode: body.bankReferenceCode } : {}),
      minLotSize: body.minLotSize,
      ...(body.maxWaitSeconds !== undefined ? { maxWaitSeconds: body.maxWaitSeconds } : {}),
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // Task 12 (W-6): the PRINT vendor print_layout admin write. Same
  // gate/idempotency/co-committed-6e posture as batching-config above; NOT
  // step-up-gated (not in OPS_STEP_UP_CATALOG). 'ops:vendor-print-layout-set'
  // is granted ONLY to the admin / super_admin roles (ops-config.ts's
  // ADMIN_TIER_PERMISSIONS), so a baseline `ops` operator is DENIED here by
  // the D2 authorize in the gate, same differentiation as batching-config.
  // The target vndr is the route PATH param (never the body, M7/S16); a
  // missing vendor or a non-PRINT target throws OpsClientError('invalid'),
  // which the app-wide OpsErrorFilter maps to a 400.
  @Post('vendors/:vndrId/print-layout')
  @HttpCode(200)
  async setVendorPrintLayoutRoute(
    @Req() req: EdgeRequest,
    @Param('vndrId') vndrId: string,
    @Body() body: VendorPrintLayoutSetBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean }> {
    const g = await this.gate(req, 'ops:vendor-print-layout-set', idem, [vndrId])
    return setVendorPrintLayout(this.deps.fulfillmentDb, {
      vndrId,
      layout: body.layout,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // Phase 3 Task 7 (BRD Annexure D): the Bank Master (identity.tenant) admin
  // create/edit. Same gate/idempotency/co-committed-6e posture as every other
  // ops mutation above; NOT step-up-gated (not in OPS_STEP_UP_CATALOG), matching
  // vendor-create/damage-reason-create's own no-step-up posture (master-data
  // maintenance, not a destructive action). The write is an IDENTITY-context
  // function called with deps.identityDb, so the edge never does a cross-context
  // DB write (C4); a duplicate bankReferenceCode / not-found target surfaces as
  // identity's OpsClientError, which the app-wide OpsErrorFilter maps to a 4xx.
  @Post('bank-masters')
  @HttpCode(200)
  async createBankMasterRoute(
    @Req() req: EdgeRequest,
    @Body() body: BankMasterCreateBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; tnntId: string | null }> {
    const g = await this.gate(req, 'ops:bank-master-create', idem, [])
    return createBankMaster(this.deps.identityDb, {
      bankReferenceCode: body.bankReferenceCode,
      displayName: body.displayName,
      address1: body.address1,
      ...(body.address2 !== undefined ? { address2: body.address2 } : {}),
      ...(body.address3 !== undefined ? { address3: body.address3 } : {}),
      city: body.city,
      district: body.district,
      country: body.country,
      pin: body.pin,
      mobile: body.mobile,
      email: body.email,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // The ops Add-merchant write (2026-08-17), the backend the Add merchant
  // dialog has been posting to since it shipped UI-first on 2026-08-14. Same
  // posture as the two routes around it: gated, idempotency-keyed, 6e
  // co-committed, and NOT step-up-gated, matching vendor-create and
  // bank-master-create (master-data creation, not a destructive action).
  //
  // The write is an IDENTITY-context function called with deps.identityDb, so
  // the edge crosses no context (C4). A duplicate VPA for the bank, an unknown
  // bank, or a blank mandatory field surfaces as identity's OpsClientError,
  // which the app-wide OpsErrorFilter maps to a 4xx.
  //
  // Submitted as docs/plan/CORPUS_SUBMISSION_2026-08-17_MERCHANT_CREATE.md and
  // NOT yet ratified; the permission string is item 5.
  @Post('merchants')
  @HttpCode(200)
  async createMerchantRoute(
    @Req() req: EdgeRequest,
    @Body() body: MerchantCreateBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; mrchId: string | null }> {
    const g = await this.gate(req, 'ops:merchant-create', idem, [])
    return createMerchant(this.deps.identityDb, {
      tnntId: body.tnntWire,
      displayName: body.displayName,
      legalName: body.legalName,
      mcc: body.mcc,
      vpa: body.vpa,
      contactName: body.contactName,
      mobile: body.mobile,
      ...(body.email !== undefined ? { email: body.email } : {}),
      address: body.address,
      ...(body.address2 !== undefined ? { address2: body.address2 } : {}),
      ...(body.address3 !== undefined ? { address3: body.address3 } : {}),
      city: body.city,
      state: body.state,
      pincode: body.pincode,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  @Post('bank-masters/:id/edit')
  @HttpCode(200)
  async editBankMasterRoute(
    @Req() req: EdgeRequest,
    @Param('id') id: string,
    @Body() body: BankMasterEditBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean; changedFields: string[] }> {
    const g = await this.gate(req, 'ops:bank-master-edit', idem, [id])
    return editBankMaster(this.deps.identityDb, {
      tnntId: id,
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.address1 !== undefined ? { address1: body.address1 } : {}),
      ...(body.address2 !== undefined ? { address2: body.address2 } : {}),
      ...(body.address3 !== undefined ? { address3: body.address3 } : {}),
      ...(body.city !== undefined ? { city: body.city } : {}),
      ...(body.district !== undefined ? { district: body.district } : {}),
      ...(body.country !== undefined ? { country: body.country } : {}),
      ...(body.pin !== undefined ? { pin: body.pin } : {}),
      ...(body.mobile !== undefined ? { mobile: body.mobile } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }
}
