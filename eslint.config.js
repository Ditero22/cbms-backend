import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'drizzle'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/**', '**/features/**'],
              message:
                'Shared domain and infrastructure helpers must not depend on feature internals.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/features/**/*.ts'],
    ignores: ['src/features/orders/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/orders/order.money*', '**/orders/order.money*'],
              message: 'Use shared fixed-point primitives; order calculations belong to orders.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts', '*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-namespace': 'off',
    },
  },
)
