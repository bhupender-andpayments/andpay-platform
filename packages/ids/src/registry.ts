/**
 * Prefix registry (spec 4, gate item I4). Every public id is
 * `<prefix>_<26 char payload>`. Prefixes are IMMUTABLE once a row exists and are
 * added only by an architecture corpus decision, never a code only change.
 * Adding a registered kind is one line here.
 *
 * The minimum set to ship now (spec 4, Section 11 registry rows):
 *   mrch (merchant), term (terminal), asgn (assignment), unit (device unit),
 *   btch (batch), shpt (shipment), vndr (vendor), api (api key record).
 */
export const ID_PREFIXES = {
  mrch: 'mrch_',
  term: 'term_',
  asgn: 'asgn_',
  unit: 'unit_',
  btch: 'btch_',
  shpt: 'shpt_',
  vndr: 'vndr_',
  api: 'api_',
  // sg_ (saga / process-manager instance). A corpus-registered prefix
  // (Section 11), implemented here per handoff spec 03 field 3; not invented.
  sg: 'sg_',
  // tnnt_ (Tenant, the operator: a bank today, AndPayments later) and prog_
  // (Program, the sponsorship wrapper). Both are Section 11 registry rows owned
  // by Platform/Identity, implemented here per handoff spec 05; not invented.
  tnnt: 'tnnt_',
  prog: 'prog_',
  // smrch_ (Sub-Merchant, the Identity context entity below Merchant in the
  // 3-tier mrch_ -> smrch_ -> asgn_ model). A Section 11 registry row.
  smrch: 'smrch_',
  // aggr_ (Aggregator, the Identity sub-tenant below Tenant in the
  // tnnt_ -> aggr_ two-level bank model; spec 2026-08-20, ratification
  // bundle item 1, submitted with that spec).
  aggr: 'aggr_',
} as const

/** The set of registered id kinds. */
export type IdKind = keyof typeof ID_PREFIXES

/** All registered kinds, in registry order. */
export const ID_KINDS = Object.keys(ID_PREFIXES) as readonly IdKind[]

declare const idKindBrand: unique symbol

/**
 * A branded public id string. Two kinds are never mutually assignable: an
 * AsgnId cannot be passed where a UnitId is expected (spec 4, acceptance 6).
 * The brand is a phantom type only; at runtime an Id is a plain string.
 */
export type Id<K extends IdKind> = string & { readonly [idKindBrand]: K }

export type MrchId = Id<'mrch'>
export type TermId = Id<'term'>
export type AsgnId = Id<'asgn'>
export type UnitId = Id<'unit'>
export type BtchId = Id<'btch'>
export type ShptId = Id<'shpt'>
export type VndrId = Id<'vndr'>
export type ApiId = Id<'api'>
export type SgId = Id<'sg'>
export type TnntId = Id<'tnnt'>
export type ProgId = Id<'prog'>
export type SmrchId = Id<'smrch'>
export type AggrId = Id<'aggr'>
