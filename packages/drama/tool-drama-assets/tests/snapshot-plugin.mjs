/** Load the matching plugin from the same source or artifact face as the snapshot launcher. */
const entry = new URL(process.env.DSH_EXAMPLE_MODE === 'lib' ? '../lib/index.js' : '../src/index.ts', import.meta.url)
export default await import(entry.href)
