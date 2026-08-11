-- W-6: the press capability. GRID_3X2 pre-imposes because the printer cannot;
-- ONE_PER_PAGE (default) is today's contract. Meaningful for PRINT vendors.
ALTER TABLE "vndr" ADD COLUMN "print_layout" TEXT NOT NULL DEFAULT 'ONE_PER_PAGE';
