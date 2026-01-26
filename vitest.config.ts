import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Only use database setup for integration tests, not unit tests
    setupFiles: [],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.test.ts',
        'scripts/', // CLI scripts, not application code
        '**/index.ts', // Re-export files
        'src/server.ts', // Entry point that just calls app.ts
      ],
    },
    testTimeout: 10000,
    // Workspace configuration for different test types
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**/*.test.ts'],
  },
})
