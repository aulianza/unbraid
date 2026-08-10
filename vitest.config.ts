import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    // Real git repos in temp dirs are slower than unit tests but still fast.
    testTimeout: 20_000,
  },
})
