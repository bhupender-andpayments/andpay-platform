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
  upsertBatchingConfig,
  ingestOpsDeviceInventory,
  type IntakeSheet,
  type OpsDeviceInventoryResult,
} from '@andpay/fulfillment-service'
import {
  previewBankFile,
  commitBankFile,
  commitDamageFile,
  resolveQuarantineRow,
  createDamageReasonOps,
  activateDamageReasonOps,
  deactivateDamageReasonOps,
  updateDamageCaseStatusOps,
  activateAssignmentOps,
  ManualDevicePort,
  type BankRequestRow,
  type BankPreviewResult,
  type DamageReasonRow,
} from '@andpay/tms-service'
import { readDispatchActivationStatus } from '@andpay/analytics-service'
import { createBankMaster, editBankMaster } from '@andpay/identity-service'
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
}
// Phase 5 Task 2 (D-H.1): the target rides in the BODY, not a route param
// (unlike hold/release/damage-case-status), because this is the FIRST caller
// of the TMS activation path (grounding section 2) and there is no existing
// `:asgnId`-scoped route shape to preserve here; dispatchId is the asgn_ wire
// id (the BRD Dispatch ID), decoded server-side by TMS, never here (D99).
interface ActivateAssignmentBody {
  dispatchId: string
}
interface BatchTriggerBody {
  tenantWire: string
  programWire: string
}
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
  minLotSize: number
  maxWaitSeconds: number
}
// Phase 3 Task 7 (BRD Annexure D): the Bank Master create body. bankReferenceCode
// (the immutable ingest resolver key) is set ONCE here at create time and is a
// legitimate request input (platform master data an AndPayments admin
// configures, not principal-scoped tenant data, unlike M7/S16); the actor/
// traceId/idempotency-key still come from the gate, never the body. address2/
// address3 are the only optional fields (BRD D.1).
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
// Phase 5 Task 1 (D-G, FR-01a): the device-inventory upload's non-file field.
// manufacturerVndrId is a RATIFIED VALIDATED BODY REFERENCE (a vndr_ wire id),
// NOT a principal scope (D99, M7/S16 do not apply): the class-3 all-programs
// ops principal has no vendor scope of its own to pin against, so the target
// manufacturer travels in the request and the fulfillment service validates
// it server-side (type='MANUFACTURER') before any write.
interface DeviceInventoryUploadBody {
  manufacturerVndrId: string
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
  // direct D2 authorize still gates access in code (the read plane relies on DB
  // read-roles to scope data; a preview touches no DB, so it gates here) and an
  // unauthorized operator gets a 403.
  @Post('uploads/bank/preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async previewBank(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedSheet | undefined,
  ): Promise<BankPreviewResult> {
    this.authorizePreview(req, 'ops:upload-bank-file')
    if (!file) throw new BadRequestException('missing file')
    return previewBankFile(file.buffer, file.originalname)
  }

  // The bank-upload commit (D-K). Multipart raw file, re-parsed SERVER-SIDE by
  // TMS (never trusting client rows). Keeps the full mutation gate (mandatory
  // Idempotency-Key, D2 authorize, co-committed ALLOW 6e) and the same
  // guard-only, NOT step-up-gated posture the old JSON route carried. A file
  // that fails structural parse throws BankFileParseError (kind:'invalid'),
  // which the app-wide OpsErrorFilter maps to a 400.
  @Post('uploads/bank/commit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async commitBank(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedSheet | undefined,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ accepted: number; quarantined: number; duplicate: number; fileId: string }> {
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

  // The damage-file commit (D-K). Multipart raw file, server-parsed; no
  // separate preview in v1 (damage validation is a DB match by tenant+vpa,
  // which a pure preview cannot do). Same gate and partial-accept as the bank
  // commit.
  @Post('uploads/damage/commit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @HttpCode(200)
  async commitDamage(
    @Req() req: EdgeRequest,
    @UploadedFile() file: UploadedSheet | undefined,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ replaced: number; quarantined: number; duplicate: number; fileId: string }> {
    const g = await this.gate(req, 'ops:upload-damage-file', idem, [])
    if (!file) throw new BadRequestException('missing file')
    return commitDamageFile(this.deps.tmsDb, {
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
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ deduped: boolean }> {
    const g = await this.gate(req, 'ops:record-hold', idem, [asgnId])
    const result = await holdRecord(this.deps.fulfillmentDb, {
      asgnId,
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
  // body carries only the new status (D99, M7/S16: no actor/scope in the body).
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
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  // Phase 5 Task 2 (D-H.1, BRD Phase-1 MANUAL activation flow): CWD activates
  // the device+SIM out of band; ops marks it here. The DELIVERED gate READ
  // happens HERE, at the edge (this.deps.analyticsDb, the LOCAL projection),
  // never inside TMS (no cross-context DB read, C4). Gate predicate is
  // deliveryDate IS NOT NULL, not a pipelineState equality check
  // (pipelineState advances to 'ACTIVATED' once the fact this triggers folds,
  // so an equality check would wrongly reject a second activation attempt).
  // A missing or not-yet-delivered row is a normal business-rule 409, not an
  // authz DENY: the D2 authorize already ALLOWed inside gate() above, and
  // since the domain op never runs, no 6e (ALLOW or DENY) is emitted for this
  // rejection. Only on a delivered row does this call activateAssignmentOps
  // with a fresh ManualDevicePort (R4: Phase-1 has no CWD-API adapter wired,
  // C6/T11 seam preserved).
  @Post('assignments/activate')
  @HttpCode(200)
  async activateAssignmentRoute(
    @Req() req: EdgeRequest,
    @Body() body: ActivateAssignmentBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ activated: boolean }> {
    const g = await this.gate(req, 'ops:mark-activated', idem, [])
    const status = await readDispatchActivationStatus(this.deps.analyticsDb, body.dispatchId)
    if (status === null || status.deliveryDate === null) {
      throw new ConflictException('not-delivered')
    }
    return activateAssignmentOps(this.deps.tmsDb, {
      asgnId: body.dispatchId,
      port: new ManualDevicePort(),
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
  }

  @Post('batches/trigger')
  @HttpCode(200)
  async batchTrigger(
    @Req() req: EdgeRequest,
    @Body() body: BatchTriggerBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ btchId: string } | null> {
    const g = await this.gate(req, 'ops:manual-batch-trigger', idem, [body.tenantWire, body.programWire])
    const result = await manualBatch(this.deps.fulfillmentDb, {
      tenantWire: body.tenantWire,
      programWire: body.programWire,
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
      minLotSize: body.minLotSize,
      maxWaitSeconds: body.maxWaitSeconds,
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
