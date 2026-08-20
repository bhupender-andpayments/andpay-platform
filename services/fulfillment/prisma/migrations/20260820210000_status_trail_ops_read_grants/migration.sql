-- Fix to 20260820195711_status_stages_21_08_2026: that migration created an
-- ops-read RLS POLICY on pool_entry_status_event and batch_status_event but
-- never GRANTed SELECT to fulfillment_ops_read, so both trail reads failed with
-- "permission denied" (surfacing as a 500 on the new /trail routes). A policy
-- decides WHICH ROWS a role may see; the grant decides whether it may look at
-- the table at all, and both are required. unit_status_event already had its
-- grant, which is why only two of the three routes broke.
GRANT SELECT ON "pool_entry_status_event" TO fulfillment_ops_read;
GRANT SELECT ON "batch_status_event" TO fulfillment_ops_read;
