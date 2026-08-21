-- DAMAGE.md (21 Aug 2026): the pool and the batch page need to tell a
-- replacement from a fresh request, and could not. replacement_of lived only on
-- tms.assignment and deliberately never rode the assignment fact, so this
-- context had nothing to show; the portal's workaround was to download every
-- damage case and join in the browser, which does not scale past one page.
--
-- The fact now carries an optional replacementOf and the pool projector copies
-- it here. Only the LINK travels: case_status stays TMS-local, because a case is
-- a complaint's lifecycle and no other context has business advancing it.
--
-- Nullable and additive. Existing rows are NOT backfilled: the information is in
-- tms and could be copied, but a backfill would claim these rows learned it from
-- their own fact when they did not, and every row that matters here is minted
-- after this lands.
ALTER TABLE "pending_pool_entry" ADD COLUMN "replacement_of" UUID;

-- Read surfaces need it; the write role already holds table-wide privileges from
-- the original domain migration, and a new COLUMN on an existing table inherits
-- them, unlike a new table.
