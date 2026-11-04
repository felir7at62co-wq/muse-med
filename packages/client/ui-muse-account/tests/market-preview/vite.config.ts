/** Build-only configuration for the local UI fixture; no Host or cloud service is started. */
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../../../../../tsconfig.base.json', import.meta.url))] })],
  esbuild: { jsx: 'automatic' },
  build: { outDir: fileURLToPath(new URL('../../../../../tmp/market-preview', import.meta.url)), emptyOutDir: true },
})
