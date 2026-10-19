/** Load the screenplay plugin from the recorded-session launcher's selected compilation output. */
const mode = process.env.DSH_EXAMPLE_MODE ?? 'src';
if (mode !== 'src' && mode !== 'lib') throw new Error('screenplay snapshot: unsupported DSH_EXAMPLE_MODE');
const entry = mode === 'lib' ? 'lib/index.js' : 'src/index.ts';
const plugin = await import(new URL('../../../packages/drama/screenplay-project/' + entry, import.meta.url).href);

/** Preserve the owning plugin's diagnostic name. */
export const name = plugin.name;
/** Preserve its required services in both launch modes. */
export const inject = plugin.inject;
/** Validate fixture configuration through the owning plugin's schema. */
export const Config = plugin.Config;
/** Mount the owning plugin's tool with its unchanged lifecycle and configuration. */
export const apply = plugin.apply;
