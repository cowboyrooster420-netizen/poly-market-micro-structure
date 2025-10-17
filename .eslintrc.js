module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module'
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended'
  ],
  root: true,
  env: {
    node: true,
    es6: true,
    jest: true
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    '*.js',
    '*.d.ts',
    'coverage/'
  ],
  rules: {
    // General ESLint rules
    'no-console': 'warn',
    'no-debugger': 'error',
    'no-duplicate-imports': 'error',
    'no-unused-expressions': 'error',
    'prefer-const': 'error',
    'no-var': 'error',
    'no-undef': 'off', // TypeScript handles this
    
    // Stylistic rules (relaxed for development)
    'indent': ['warn', 2, { SwitchCase: 1 }],
    'quotes': ['warn', 'single', { avoidEscape: true }],
    'semi': ['error', 'always'],
    'comma-dangle': 'off', // Allow trailing commas
    'object-curly-spacing': ['warn', 'always'],
    'array-bracket-spacing': ['warn', 'never'],
    
    // Performance and best practices
    'no-await-in-loop': 'warn',
    'prefer-arrow-callback': 'warn',
    'prefer-template': 'warn',
    'no-useless-concat': 'warn',
    
    // Security
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    
    // Error handling
    'no-throw-literal': 'error',
    'prefer-promise-reject-errors': 'error'
  },
  overrides: [
    {
      files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
      env: {
        jest: true
      },
      rules: {
        'no-console': 'off'
      }
    },
    {
      files: ['src/cli/**/*.ts'],
      rules: {
        'no-console': 'off'
      }
    },
    {
      files: ['*.js'],
      env: {
        commonjs: true
      }
    }
  ]
};