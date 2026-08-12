import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      /*
       * Extension tests import `unbraid` as a package. Point that at the source
       * rather than the built bundle.
       *
       * Without this, `npm test` depends on `npm run build` having run first —
       * which it has not in CI, where tests run before the build, and which is
       * worse when it has: the suite would then pass against whatever was built
       * last rather than the code being tested.
       */
      unbraid: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
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
