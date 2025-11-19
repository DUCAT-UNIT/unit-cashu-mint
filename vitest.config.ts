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
        'scripts/', // CLI scripts, not application code
        '**/index.ts', // Re-export files
        'src/server.ts', // Entry point that just calls app.ts
      ],
    },
    testTimeout: 10000,
  },
})
