/** Select the discovery plugin from the launcher's declared source or artifact plane. */
const entry = new URL(process.env.DSH_EXAMPLE_MODE === 'lib' ? '../lib/index.js' : '../src/index.ts', import.meta.url)
export default await import(entry.href)
