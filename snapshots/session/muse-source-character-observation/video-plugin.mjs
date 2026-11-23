/** Mount the actual observation plugin from the launcher's source or built face. */
const entry = new URL(process.env.DSH_EXAMPLE_MODE === 'lib'
  ? '../../../packages/perception/tool-video-inspect/lib/index.js'
  : '../../../packages/perception/tool-video-inspect/src/index.ts', import.meta.url)
export default await import(entry.href)
