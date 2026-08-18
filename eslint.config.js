import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/generated/**',
      // Standalone CDK project with its own toolchain (aws-cdk-lib), deployed
      // out of band and not part of the workspace typecheck/lint.
      'infra/aws/**',
      // Local-only development reference (gitignored): corpus copies, build
      // ledger, plans, and raw acceptance-evidence scripts. Not shipped source.
      'docs/**',
      'evidence/**',
      // Harness scratch: agent worktrees are full checkouts and would double
      // every finding.
      '.claude/**',
      '.superpowers/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Allow intentionally-unused identifiers prefixed with _ (interface-mandated
    // stub parameters that a concrete implementation does not consume, e.g. the
    // deferred MFA adapters and the unwired Identity fact-read seam).
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // infra scripts (db-url.mjs and friends) are plain Node ESM run outside
    // the TypeScript workspace: give them the Node globals so no-undef does
    // not flag process/console. Behavior of the scripts is untouched.
    files: ['infra/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    // ops-portal is the first React app in the workspace: scope JSX parsing to
    // its .tsx/.ts sources only, so the rest of the (node-only) workspace is
    // unaffected.
    files: ['apps/ops-portal/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
)
