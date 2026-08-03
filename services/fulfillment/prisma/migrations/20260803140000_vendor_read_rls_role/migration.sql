-- Spec 14b: the vendor-axis READ role + RESTRICTIVE FOR SELECT policies.
-- A print vendor prints across many programs, so the vendor read cuts on
-- print_vndr, NOT program_id. Only batch carries print_vndr; the other three
-- tables reach it via EXISTS-to-batch. Role-targeted (TO fulfillment_vendor_read)
-- so these COMPOSE with the existing program-axis tenant-read policies (which
-- target fulfillment_read), never conflict. Fail-closed: set_config('app.vndr_id',
-- ..., true) is transaction-LOCAL, but once the custom GUC placeholder has been
-- introduced on a connection it reverts to the empty string '' (NOT NULL) after
-- the tx, for the rest of that connection's lifetime; a plain
-- current_setting(...)::uuid cast on that '' throws 22P02 instead of failing
-- closed. NULLIF(current_setting('app.vndr_id', true), '') maps the reverted
-- empty string (and a truly never-set GUC) back to NULL, so the ::uuid cast
-- yields NULL, every predicate is false, and the row is hidden with a clean
-- zero-row result rather than a thrown error, regardless of connection history.
-- Same idiom as services/analytics/prisma/migrations/20260730130000_analytics_q5_nullif_harden.
-- Additive/reversible (S23).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fulfillment_vendor_read') THEN
    CREATE ROLE fulfillment_vendor_read NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA fulfillment TO fulfillment_vendor_read;
GRANT SELECT ON fulfillment.batch, fulfillment.pending_pool_entry, fulfillment.shpt TO fulfillment_vendor_read;
-- unit carries sim_no (ICCID, sensitive-by-default per spec 15, "NEVER emitted")
-- and device_qr (also sensitive). RLS gates rows, not columns, so this GRANT is
-- COLUMN-SCOPED to every real unit column except sim_no and device_qr: even an
-- accidental SELECT sim_no under this role is a permission error, not a
-- row-filtered leak. Verified against services/fulfillment/prisma/schema.prisma
-- (model Unit): id, kind, product_type, manufacturer_vndr, batch, status,
-- device_serial, device_qr(EXCLUDED), sim_no(EXCLUDED), shipment,
-- printed_for_merchant, location, qr_string, procured, allocated, printed,
-- dispatched, delivered, returned, scrapped, created_at, updated_at.
GRANT SELECT (id, kind, product_type, manufacturer_vndr, batch, status, device_serial, shipment, printed_for_merchant, location, qr_string, procured, allocated, printed, dispatched, delivered, returned, scrapped, created_at, updated_at) ON fulfillment.unit TO fulfillment_vendor_read;

CREATE POLICY "batch_vendor_read" ON "batch"
  AS RESTRICTIVE FOR SELECT TO fulfillment_vendor_read
  USING (print_vndr = NULLIF(current_setting('app.vndr_id', true), '')::uuid);

CREATE POLICY "pending_pool_entry_vendor_read" ON "pending_pool_entry"
  AS RESTRICTIVE FOR SELECT TO fulfillment_vendor_read
  USING (EXISTS (SELECT 1 FROM batch b WHERE b.id = pending_pool_entry.batch
                 AND b.print_vndr = NULLIF(current_setting('app.vndr_id', true), '')::uuid));

CREATE POLICY "unit_vendor_read" ON "unit"
  AS RESTRICTIVE FOR SELECT TO fulfillment_vendor_read
  USING (EXISTS (SELECT 1 FROM batch b WHERE b.id = unit.batch
                 AND b.print_vndr = NULLIF(current_setting('app.vndr_id', true), '')::uuid));

CREATE POLICY "shpt_vendor_read" ON "shpt"
  AS RESTRICTIVE FOR SELECT TO fulfillment_vendor_read
  USING (EXISTS (SELECT 1 FROM unit u JOIN batch b ON b.id = u.batch
                 WHERE u.shipment = shpt.id
                 AND b.print_vndr = NULLIF(current_setting('app.vndr_id', true), '')::uuid));
