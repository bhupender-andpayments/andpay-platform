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
  UseGuards,
} from '@nestjs/common'
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
  resolveIntakeException,
  resolveStatusException,
  isKnownStatus,
  type IntakeSheet,
} from '@andpay/fulfillment-service'
import {
  uploadBankFile,
  uploadDamageFile,
  resolveQuarantineRow,
  type BankRequestRow,
  type BankDamageRow,
} from '@andpay/tms-service'
import { OpsEdgeGuard } from './guard.js'
import { EDGE_DEPS, type OpsEdgeDeps } from './deps.js'
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
}
interface UploadBankBody {
  rows: BankRequestRow[]
}
interface UploadDamageBody {
  rows: BankDamageRow[]
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

// The class-3 ops MUTATION edge (spec 10c, Task 9). @UseGuards is declared at
// the CLASS level so EVERY route is authenticated by construction (never rely on
// a per-method guard a future route could forget). Every mutation runs the same
// gate (Fork D client action key -> optional per-action STEP-UP -> D2 authorize),
// emits a 6e DENY only on an edge-gate rejection (authz-deny or step-up-required;
// a missing action key is a 400, not a 6e), then calls the in-process domain op
// and, on domain SUCCESS, emits exactly ONE 6e ALLOW (audit-AFTER-success: a
// write portal audits what actually happened; a domain no-op, a C3 non-advance
// or a deduped replay, is still an authorized action and still an ALLOW). IDs
// and enums only ride the 6e; PII and free text never leave the domain row.
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
  private async gate(
    req: EdgeRequest,
    operation: string,
    idempotencyKey: string | undefined,
    resourceIds: string[],
    stepUpKey?: string,
  ): Promise<Gated> {
    const actorId = req.claim.sub
    const clientKey = idempotencyKey
    if (clientKey === undefined || clientKey.trim() === '') {
      throw new BadRequestException('Idempotency-Key header is required')
    }

    if (stepUpKey !== undefined) {
      const entry = OPS_STEP_UP_CATALOG[stepUpKey]
      // Fail closed on a missing catalog entry (a server misconfiguration): a
      // step-up-gated route must never fall through to an unstepped authorize.
      if (entry === undefined) throw new ForbiddenException()
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

  // The single post-success ALLOW emit (template step g). `extra` carries the
  // terminal-override enum reasonCode and the step-up assurance (acr, auth_time)
  // for the one C3-bypass action; every other action passes none.
  private async allow(
    g: Gated,
    operation: string,
    resourceIds: string[],
    extra?: { reasonCode?: string; acr?: EdgeRequest['claim']['acr']; authTime?: number },
  ): Promise<void> {
    await emitOpsAuthzAudit(this.deps.fulfillmentDb, {
      principalId: g.actorId,
      operation,
      decision: 'ALLOW',
      outcome: 'allowed',
      reasonCode: extra?.reasonCode,
      acr: extra?.acr,
      authTime: extra?.authTime,
      resourceIds,
      traceId: g.traceId,
    })
  }

  @Post('uploads/bank')
  @HttpCode(200)
  async uploadBank(
    @Req() req: EdgeRequest,
    @Body() body: UploadBankBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ accepted: number; quarantined: number; duplicate: number }> {
    const g = await this.gate(req, 'ops:upload-bank-file', idem, [])
    const result = await uploadBankFile(this.deps.tmsDb, {
      rows: body.rows,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    await this.allow(g, 'ops:upload-bank-file', [])
    return result
  }

  @Post('uploads/damage')
  @HttpCode(200)
  async uploadDamage(
    @Req() req: EdgeRequest,
    @Body() body: UploadDamageBody,
    @Headers('idempotency-key') idem: string | undefined,
  ): Promise<{ replaced: number; quarantined: number; duplicate: number }> {
    const g = await this.gate(req, 'ops:upload-damage-file', idem, [])
    const result = await uploadDamageFile(this.deps.tmsDb, {
      rows: body.rows,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    await this.allow(g, 'ops:upload-damage-file', [])
    return result
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
    await this.allow(g, 'ops:status-correction', [id])
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
    const result = await overrideTerminal(this.deps.fulfillmentDb, {
      shptId: id,
      status: body.status,
      courierTimestamp: new Date(body.courierTimestamp),
      overrideReason: body.overrideReason,
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    // The free-text overrideReason lives ONLY on the domain row (DD1); the 6e
    // carries the enum reasonCode plus the step-up assurance that authorized it.
    await this.allow(g, 'ops:terminal-override', [id], {
      reasonCode: 'terminal-override',
      acr: req.claim.acr,
      authTime: req.claim.auth_time,
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
    await this.allow(g, 'ops:recompose-artifact', [body.asgnId])
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
    await this.allow(g, 'ops:record-hold', [asgnId])
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
    await this.allow(g, 'ops:record-release', [asgnId])
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
    await this.allow(g, 'ops:manual-batch-trigger', [body.tenantWire, body.programWire])
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
      clientKey: g.clientKey,
      actorId: g.actorId,
      traceId: g.traceId,
    })
    // The created vendor id is the only target id, and only on a fresh create.
    await this.allow(g, 'ops:vendor-create', result.vndrId !== null ? [result.vndrId] : [])
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
    await this.allow(g, 'ops:vendor-suspend', [id])
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
    await this.allow(g, 'ops:resolve-quarantine', [id])
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
    await this.allow(g, 'ops:resolve-intake-exception', [id])
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
    await this.allow(g, 'ops:resolve-status-exception', [id])
    return result
  }
}
