import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'index': 'lib/types/index.js',
    'source-qa': 'lib/types/source-qa-api.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  outputOptions: { chunkFileNames: 'shared-[hash].js' },
})
