import { configDefaults, defineConfig } from 'vitest/config'

// The node/NestJS suites and the ops-portal (jsdom + React) suite need
// different test environments. `projects` isolates them: each project
// resolves its own config independently, so jsdom/the react-jsx transform
// never leaks into the node project, and the node project's settings
// (include globs, environment, fileParallelism, typecheck) are unchanged
// from before ops-portal existed. `environmentMatchGlobs` (the older,
// single-environment-config way to do this) is deprecated in vitest 3 and
// emits a warning, so it is not used here.
export default defineConfig({
  test: {
    // Root-only option (not settable per-project in vitest 3's `ProjectConfig`
    // type): integration tests share singleton infra (one Postgres schema, one
    // Kafka), so all test files across every project still run serially, same
    // as before ops-portal existed. One extra jsdom smoke test running
    // serially too is immaterial to run time.
    fileParallelism: false,
    // ONE teardown for the whole run (F-9c), rather than an afterAll in each of
    // the 82 suites that truncate in beforeEach only. Root-level and outside
    // `projects` on purpose: it must run ONCE after everything, not once per
    // project. It exports `teardown` and no meaningful setup. See the file for
    // the two guards (auth is never touched; unseeded master data is preserved)
    // and for the ANDPAY_SKIP_TEST_TEARDOWN=1 escape hatch.
    globalSetup: ['./vitest.global-teardown.ts'],
    projects: [
      {
        test: {
          name: 'node',
          include: ['packages/**/test/**/*.test.ts', 'services/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'apps/ops-portal/**', 'apps/vendor-portal/**'],
          environment: 'node',
          // Marks that a DATABASE-BACKED suite actually ran, which is the only
          // condition under which the global teardown is allowed to truncate
          // anything (its GUARD 3). Without this, a jsdom-only run - which
          // opens no connection - still triggered the truncation and destroyed
          // live dev data. This project is the only one whose suites use
          // Postgres, so the marker belongs here and nowhere else.
          setupFiles: ['./test/db-tests-ran.setup.ts'],
          typecheck: {
            // Under `projects`, the root's CLI-forwarded options are filtered
            // to a fixed allow-list that excludes `typecheck` (vitest only
            // forwards logHeapUsage/allowOnly/sequence/testTimeout/pool/update/
            // globals/etc. per-project). So the root "test" script's
            // `vitest run --typecheck` flag no longer reaches this project on
            // its own; `enabled: true` is set explicitly here so the
            // *.test-d.ts type-check pass keeps running exactly as before.
            enabled: true,
            include: ['packages/**/test/**/*.test-d.ts', 'services/**/test/**/*.test-d.ts', 'apps/**/test/**/*.test-d.ts'],
            tsconfig: './tsconfig.json',
          },
        },
      },
      'apps/ops-portal/vitest.config.ts',
      'apps/vendor-portal/vitest.config.ts',
    ],
  },
})
