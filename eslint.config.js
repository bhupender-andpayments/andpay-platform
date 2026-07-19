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
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
