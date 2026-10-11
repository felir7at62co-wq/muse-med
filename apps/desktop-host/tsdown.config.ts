import { defineConfig } from 'tsdown'

export default defineConfig(['index', 'cli', 'native-preset', 'creation-policy', 'creation-skills', 'short-drama-guidance'].map(name => ({
  entry: ['lib/types/' + name + '.js'],
  outDir: 'lib',
  format: ['esm'] as const,
  outputOptions: { codeSplitting: false },
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})))
