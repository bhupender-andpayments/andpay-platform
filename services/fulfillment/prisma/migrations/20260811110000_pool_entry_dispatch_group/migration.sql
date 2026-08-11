-- W-5: the dispatch group marker off fct.tms.assignment.v1. NULL means a legacy
-- combined row; downstream membership and pairing branch on that NULL to
-- keep pre-split semantics. Deliberately never backfilled.
ALTER TABLE "pending_pool_entry" ADD COLUMN "dispatch_group" TEXT;
