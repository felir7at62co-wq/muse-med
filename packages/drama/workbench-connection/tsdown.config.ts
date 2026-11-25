import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'index': 'lib/types/index.js',
    'transport': 'lib/types/transport.js',
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
