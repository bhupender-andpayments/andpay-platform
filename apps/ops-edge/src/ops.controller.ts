import {
  BadRequestException,
  Body,
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
  type IntakeSheet,
} from '@andpay/fulfillment-service'
import {
  previewBankFile,
  commitBankFile,
  commitDamageFile,
  resolveQuarantineRow,
  createDamageReasonOps,
  activateDamageReasonOps,
  deactivateDamageReasonOps,
  type BankRequestRow,
  type BankPreviewResult,
  type DamageReasonRow,
} from '@andpay/tms-service'
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
}
