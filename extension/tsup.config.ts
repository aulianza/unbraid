import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/extension.ts'],
  // VS Code loads extensions as CommonJS from a single file.
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  clean: true,
  dts: false,
  sourcemap: true,
  // `vscode` is provided by the host at runtime and must never be bundled.
  external: ['vscode'],
  // Everything else is bundled so the published .vsix carries no node_modules.
  // The negative lookahead matters: a bare /.*/ here also matches `vscode` and
  // overrides the `external` above, which fails the build with "Could not
  // resolve vscode".
  //
  // unbraid's library entry never statically imports Ink or React — the terminal
  // UI is a dynamic import inside the CLI entry — so they tree-shake away.
  noExternal: [/^(?!vscode$).*/],
})
