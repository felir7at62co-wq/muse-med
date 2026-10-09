/** Mount the actual delivery plugins in both supported snapshot launch modes. */
const mode = process.env.DSH_EXAMPLE_MODE ?? 'src';
if (mode !== 'src' && mode !== 'lib') throw new Error('video delivery snapshot: unsupported DSH_EXAMPLE_MODE');
const present = await import(new URL('../../../packages/deliverables/tool-present/' + (mode === 'lib' ? 'lib/index.js' : 'src/index.ts'), import.meta.url).href);
const docx = await import(new URL('../../../apps/desktop-host/' + (mode === 'lib' ? 'lib/types/screenplay-docx.js' : 'src/screenplay-docx.ts'), import.meta.url).href);

/** Fixture composition identity. */
export const name = 'video-delivery';
/** Mount after the normal agent services exist. */
export const inject = ['tools', 'fs', 'sessionProjections'];
/** Mount unmodified executors; conversion is never called in this fixture. */
export function apply(ctx) {
  ctx.plugin(present, { maxFiles: 8 });
  ctx.plugin(docx, { source: './unused-runtime', maxInputBytes: 1000000, maxProjectBytes: 1000000, timeoutMs: 30000 });
}
