-- The FORWARD replacement lookup, 23 Aug 2026.
--
-- pending_pool_entry.replacement_of has been read child-to-parent since it was
-- added (readReplacementMarksOps, WHERE asgn_id = ANY(...)), which rides the
-- existing unique on asgn_id. The device detail page now also asks the reverse
-- question, "which dispatch replaced THIS one", which is WHERE replacement_of =
-- <asgn>, and nothing indexed that column at all.
--
-- Partial, because the question is only ever asked of replacements and the
-- overwhelming majority of pool entries are originals with a NULL here. A
-- partial index keeps out every row that could never match.
CREATE INDEX IF NOT EXISTS "pending_pool_entry_replacement_of_idx"
  ON "pending_pool_entry" ("replacement_of")
  WHERE "replacement_of" IS NOT NULL;
