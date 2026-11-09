import { defineConfig } from 'tsdown'

export default defineConfig([{
  entry: ['lib/types/index.js', 'lib/types/package.js', 'lib/types/format.js', 'lib/types/activation.js', 'lib/types/cloud.js', 'lib/types/cloud-host.js', 'lib/types/cloud-values.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  outputOptions: { chunkFileNames: 'shared-[hash].js' },
}, {
  entry: { 'cloud-values.browser': 'lib/types/cloud-values.js' }, outDir: 'lib',
  format: ['esm'], platform: 'browser', target: 'es2024', splitting: false,
  fixedExtension: false, dts: false, clean: false, noExternal: [/^@deepseek-ai\//],
}])
