import { defineConfig } from 'tsdown'

export default defineConfig(['index', 'main', 'worker', 'policy'].map(name => ({
  entry: ['lib/types/' + name + '.js'], outDir: 'lib', format: ['esm'] as const,
  platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
})))
