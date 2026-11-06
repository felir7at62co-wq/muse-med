/** Build the standalone website from the same market components as the Muse client. */
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/market/ui/',
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url))] })],
  esbuild: { jsx: 'automatic' },
  build: { outDir: fileURLToPath(new URL('../../tmp/market-cloud-web', import.meta.url)), emptyOutDir: true },
})
