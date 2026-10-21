import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['src/v2/**/*.ts'],
  extends: [js.configs.recommended, ...tseslint.configs.recommended],
  languageOptions: {
    globals: {
      process: 'readonly',
      console: 'readonly',
      Buffer: 'readonly',
      require: 'readonly',
      module: 'readonly',
      __dirname: 'readonly',
      fetch: 'readonly',
      URL: 'readonly',
      Request: 'readonly',
      Response: 'readonly',
      Headers: 'readonly',
      AbortSignal: 'readonly',
      TextDecoder: 'readonly',
    },
  },
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/no-require-imports': 'off',
    'prefer-const': 'error',
    curly: ['error', 'all'],
    'no-param-reassign': ['error', { props: true }],
    'no-restricted-syntax': [
      'error',
      {
        selector:
          "UpdateExpression[argument.type='MemberExpression'], UnaryExpression[operator='delete']",
        message: 'Prefer immutable object updates.',
      },
      {
        selector: "AssignmentExpression[left.type='MemberExpression']",
        message: 'Create an updated value with spread instead of mutating an object.',
      },
      {
        selector:
          "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|add|delete|clear)$/]",
        message:
          'Prefer immutable collection updates. Document a narrowly scoped exception when mutation is required.',
      },
    ],
  },
});
