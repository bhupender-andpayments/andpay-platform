// The SAMPLE card renderer (standee-frame flow, Task 4, 24 Aug 2026): the
// exact PDF a real dispatch would produce for a bank, with the variable data
// replaced by fixed sample values, so an operator can see the finished card
// in Master Data before any batch exists.
//
// The config resolution here deliberately mirrors dispatch.ts preRenderArtifacts
// piece by piece: the same bankConfigCandidateKeys precedence, the same
// per-field template/calibration/banner fallback to the tenant default row,
// the same prefer-the-derivative logo rule. What the preview shows IS what a
// compose would store; a drift between the two would make the preview a lie,
// which is why both read the same helpers rather than restating the rules.
//
// A READ, not a write: no transaction beyond the scoped SELECT, no outbox, no
// audit. The sample values are fixed constants so the render is deterministic
// and cache-friendly, exactly like the renderer's own contract.
import type { Tx } from '../internal.js'
import { bankConfigCandidateKeys } from '../config/bank-config-fallback.js'
import type { AssetStore } from '../storage/asset-store.js'
import { renderCollateralPdf, type ArtifactType } from './renderer.js'

// The FulfillmentDb structural type used across this package.
interface FulfillmentDb {
  $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
}

interface ConfigRow {
  bank_code: string
  branch_code: string
  branding_params: unknown
  image_templates: unknown
  logo_master_ref: string | null
  logo_derivative_ref: string | null
  soundbox_template_ref: string | null
  collateral_template_ref: string | null
  header_banner_ref: string | null
}

const SAMPLE = {
  dispatchId: 'asgn_SAMPLE00000000000000000000',
  qrValue: 'upi://pay?pa=sample.merchant@gscb&pn=Sample%20Merchant',
  vpa: 'sample.merchant@gscb',
  merchantDisplayName: 'SAMPLE MERCHANT',
  merchantLegalName: 'Sample Merchant Pvt Ltd',
}

export interface RenderSampleCardInput {
  bankCode: string
  bankName: string
  artifactType: ArtifactType
}

/**
 * Render one sample card for a bank from its CURRENT master data. Returns the
 * PDF bytes; never null (a bank with no config at all renders the drawn
 * fallback, which is itself an honest preview of what a compose would ship).
 */
export async function renderSampleCard(
  db: FulfillmentDb,
  assetStore: AssetStore,
  input: RenderSampleCardInput,
): Promise<Uint8Array> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    return tx.$queryRaw<ConfigRow[]>`
      SELECT bank_code, branch_code, branding_params, image_templates, logo_master_ref,
             logo_derivative_ref, soundbox_template_ref, collateral_template_ref, header_banner_ref
      FROM bank_composition_config
    `
  })
  const byKey = new Map<string, ConfigRow>(rows.map((r) => [`${r.bank_code}|${r.branch_code}`, r]))
  let cfg: ConfigRow | null = null
  for (const key of bankConfigCandidateKeys(input.bankCode, null)) {
    const hit = byKey.get(`${key.bankCode}|${key.branchCode}`)
    if (hit !== undefined) {
      cfg = hit
      break
    }
  }
  const defaultCfg = byKey.get('|') ?? null

  const templateRef =
    (input.artifactType === 'SOUNDBOX_IMG'
      ? (cfg?.soundbox_template_ref ?? defaultCfg?.soundbox_template_ref)
      : (cfg?.collateral_template_ref ?? defaultCfg?.collateral_template_ref)) ?? null
  const logoRef = cfg?.logo_derivative_ref ?? cfg?.logo_master_ref ?? null
  const bannerRef = cfg?.header_banner_ref ?? defaultCfg?.header_banner_ref ?? null

  const resolve = async (ref: string | null) => {
    if (ref === null) return null
    const rec = await assetStore.getByReference(ref)
    return rec === null ? null : { bytes: rec.bytes, contentType: rec.meta.contentType }
  }
  const [master, logo, banner] = await Promise.all([resolve(templateRef), resolve(logoRef), resolve(bannerRef)])

  const typeKey = input.artifactType.replace('_IMG', '')
  const imageTemplateOf = (row: ConfigRow | null): unknown => {
    const t = row?.image_templates
    if (t !== null && typeof t === 'object' && t !== undefined && typeKey in t) {
      return (t as Record<string, unknown>)[typeKey]
    }
    return undefined
  }

  return renderCollateralPdf({
    artifactType: input.artifactType,
    ...SAMPLE,
    bankName: input.bankName,
    bankCode: input.bankCode,
    imageTemplate: imageTemplateOf(cfg) ?? imageTemplateOf(defaultCfg),
    brandingParams: cfg?.branding_params,
    logo,
    headerBanner: banner,
    templateMaster: master === null ? null : { bytes: master.bytes },
  })
}
