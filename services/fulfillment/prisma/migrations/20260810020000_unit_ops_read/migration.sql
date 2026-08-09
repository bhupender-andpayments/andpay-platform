-- Device inventory for the ops console.
--
-- `unit` carries the whole device lifecycle (IN_STOCK -> ALLOCATED -> PRINTED
-- -> DISPATCHED -> DELIVERED -> ACTIVATED, plus the DAMAGED/RETURNED
-- branches) and was readable by NO ops role, so no operator could see a single
-- device: not a stock count, not a lookup, not which devices a batch became.
-- Measured on a full end-to-end run, 14 devices sat in the warehouse and
-- appeared on no screen in the portal.
--
-- There is NO ALTER DEFAULT PRIVILEGES in this schema, so a newly read table
-- needs its own explicit GRANT. This is that grant.
--
-- COLUMN-SCOPED, and the exclusions are the point. It mirrors the
-- fulfillment_vendor_read grant in 20260803140000 exactly:
--   * `sim_no` is the ICCID. 20260803120000 states it is never emitted on a
--     fact (S7) and is granted to no read role. Widening that here would be a
--     permission-surface change, which is D-6's open question, not something
--     to slip into a read.
--   * `device_qr` is the manufacturer payload, excluded for the same reason.
-- Everything else is already visible to the vendor read role, so this grants
-- ops no more than a print vendor can already see about a device.
GRANT SELECT (
  id, kind, product_type, manufacturer_vndr, batch, status, device_serial,
  shipment, printed_for_merchant, asgn_id, location, procured, allocated,
  printed, dispatched, delivered, returned, scrapped, created_at, updated_at
) ON fulfillment.unit TO fulfillment_ops_read;
