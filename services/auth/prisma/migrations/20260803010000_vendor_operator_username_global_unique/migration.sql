-- Spec 14a whole-branch audit finding (task 16, Bhupender's ruling):
-- lookupVendorOperatorByUsername resolves by username ALONE
-- (findFirst/findUnique on username), but the schema only enforced
-- uniqueness COMPOSITE (vndr_id, username). Two vendors could provision the
-- same username and the by-username lookup would return an arbitrary row,
-- silently locking out the other operator. Fix: make username GLOBALLY
-- unique, mirroring internal_principal.login_handle (also globally
-- @unique). The old composite unique is dropped; a global unique on
-- username subsumes it (vndr_id remains the scope-binding column, just no
-- longer part of any unique index).

-- DropIndex: the old composite unique (vndr_id, username).
DROP INDEX "auth"."vendor_operator_vndr_id_username_key";

-- CreateIndex: global unique on username alone.
CREATE UNIQUE INDEX "vendor_operator_username_key" ON "auth"."vendor_operator"("username");
