-- ACTIVATION.md (21 Aug 2026): activation simplified to a parallel flag.
-- The team ruled there is no useful "request sent to CWD" window worth
-- tracking; activation is one toggle, not a two-step lifecycle. This drops
-- the old activation_status column (14 non-null rows, all REQUEST_SENT_TO_CWD
-- or ACTIVATED, historical only) and its log table (14 rows): activation
-- never had a log by design going forward (see UnitStatusEvent's own
-- comment in the fulfillment schema for the same reasoning on the device
-- side). activated_at is unaffected and keeps every real activation date.
--
-- DAMAGE.md (21 Aug 2026): the cancel-a-damage-request flow needs the case to
-- record why, who, and when it was cancelled.
ALTER TABLE "assignment" DROP COLUMN "activation_status",
ADD COLUMN     "activated_by" UUID,
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(6),
ADD COLUMN     "cancelled_by" UUID,
ADD COLUMN     "case_cancel_remarks" TEXT;

-- DropTable
DROP TABLE "assignment_activation_event";

-- CHECK constraints (STATUS_STAGES.md / DAMAGE.md): case_status gains
-- Cancelled as a fourth terminal value.
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_case_status_check"
  CHECK ("case_status" IS NULL OR "case_status" IN ('Open', 'In-Progress', 'Closed', 'Cancelled'));
