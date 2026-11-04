import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/package.js', 'lib/types/server.js', 'lib/types/skills.js', 'lib/types/cloud-host.js',
    'lib/types/bot-skills.js', 'lib/types/format.js', 'lib/types/types.js'],
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
})
