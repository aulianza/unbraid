import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      // The extension's pure modules run in the same suite, so a change to the
      // shared library breaks both front ends in one place rather than two.
      'extension/src/**/*.test.ts',
    ],
    environment: 'node',
    // Real git repos in temp dirs are slower than unit tests but still fast.
    testTimeout: 20_000,
  },
})
