import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'test/**/*.test.ts'],
    // Integration tests share singleton infra (one Postgres schema, one Kafka).
    // Run test files serially so one file's TRUNCATE never races another's rows.
    fileParallelism: false,
    typecheck: {
      include: ['packages/**/test/**/*.test-d.ts'],
      tsconfig: './tsconfig.json',
    },
  },
})
