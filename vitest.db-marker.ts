import { join } from 'node:path'

// The one definition of the "database-backed tests actually ran" marker path,
// shared by the `node` project's setup file (which writes it) and the global
// teardown (which reads it, then removes it). Kept in its own module so the two
// can never drift onto different paths - a teardown looking at the wrong path
// would silently go back to truncating after every run, which is exactly the
// data loss this marker exists to prevent.
//
// Under node_modules/.cache because that is already gitignored and is wiped by
// a reinstall, so a stale marker can never outlive a checkout.
export const DB_TESTS_RAN_MARKER = join(process.cwd(), 'node_modules', '.cache', 'andpay-db-tests-ran')
