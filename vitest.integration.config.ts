import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.test.ts',
        'scripts/',
        '**/index.ts',
        'src/server.ts',
      ],
    },
    testTimeout: 10000,
    include: ['tests/integration/**/*.test.ts'],
  },
})
