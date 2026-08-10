-- Spec 2026-08-10 (dispatch package, track B): the per-bank vector background
-- masters, one per DELIVERY GROUP rather than per product type, because
-- sticker and standee share one artwork (BRD Annexure A) while the soundbox
-- design is its own. Nullable and additive: a bank without a master keeps the
-- drawn fallback layout, and no existing row changes meaning.
ALTER TABLE bank_composition_config
  ADD COLUMN soundbox_template_ref text,
  ADD COLUMN collateral_template_ref text;
