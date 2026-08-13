import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DB_TESTS_RAN_MARKER } from '../vitest.db-marker.js'

// WHY THIS FILE EXISTS (2026-08-13, after a real data loss).
//
// `vitest.global-teardown.ts` truncates the four domain schemas after the run.
// It is registered as a ROOT-level `globalSetup`, so it fires after ANY vitest
// invocation from the repo root - including one scoped to a single jsdom
// project that opens no database connection at all. That is how
// `pnpm vitest run --project ops-portal test/features/uploads.test.tsx`, a pure
// React test, deleted a working dev database's units, vendors, merchants and
// assignments: the teardown cannot see WHICH tests ran, so it cleaned up after
// tests that never touched a row.
//
// This setup file runs once per test FILE in the `node` project (the only
// project whose suites talk to Postgres) and drops a marker. The teardown
// truncates only when the marker is present, so a run that touched no database
// now leaves the database exactly as it found it.
//
// It is a marker file rather than an in-process global because globalSetup's
// teardown runs in the main vitest process while suites run in workers: they
// share no memory, only the filesystem.
mkdirSync(dirname(DB_TESTS_RAN_MARKER), { recursive: true })
writeFileSync(DB_TESTS_RAN_MARKER, new Date().toISOString(), 'utf8')
