import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'index': 'lib/types/index.js',
    'source-qa': 'lib/types/source-qa-api.js',
    'delivery': 'lib/types/delivery-api.js',
    'subtitles': 'lib/types/subtitles-api.js',
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
