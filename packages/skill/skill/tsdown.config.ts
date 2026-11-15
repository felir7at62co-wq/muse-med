import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/name.js'], outDir: 'lib',
  format: ['esm'], platform: 'node', target: 'es2024', splitting: false,
  fixedExtension: false, dts: false, clean: false,
})
