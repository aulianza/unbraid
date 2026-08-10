import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  version: string
}

export default defineConfig({
  // Injected at build time so `unbraid --version` can never drift from
  // package.json, which is what a hardcoded string in the CLI eventually does.
  define: { __UNBRAID_VERSION__: JSON.stringify(version) },
  entry: ['src/cli/index.ts', 'src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  dts: false,
  sourcemap: false,
  // Dependencies stay external. Bundling them into ESM was tried and reverted:
  // yaml's CJS build calls require('process'), which esbuild turns into a
  // "Dynamic require is not supported" throw at startup. npm resolves these
  // normally, and the startup cost is not worth that class of breakage.
  // No `banner` here: src/cli/index.ts already carries its own shebang, and a
  // banner would both duplicate it and wrongly prepend one to the library entry.
})
