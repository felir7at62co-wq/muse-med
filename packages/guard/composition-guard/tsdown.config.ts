import { defineConfig } from 'tsdown'

/**
 * Build the plugin entry and the invariant companion as independent bundles.
 *
 * The companion is what makes this package need an override at all. It reads the
 * guard's live baselines through the package's own entry point
 * (`guardState`), and plain Node resolves that self-reference through this
 * package's `exports` to `lib/index.js` — the exact module the composed row
 * loads. Inlining the entry into the companion instead would give the companion
 * a SECOND copy of `baseline.ts`'s module-level record map, and a companion that
 * always reads an empty map is an inert check that looks like coverage. The
 * `external` entry below is therefore load-bearing, not an optimization.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/invariant.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: ['@deepseek-ai/dsh-composition-guard'],
  },
])
