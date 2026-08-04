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
      // Throwaway demo tooling (branch demo/ops-portal-skin): plain Node .mjs
      // scripts that boot the local edge stack and seed data for the seeded
      // ops-portal demo. Not shipped source, not part of the workspace lint.
      'apps/ops-portal/demo/**',
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
